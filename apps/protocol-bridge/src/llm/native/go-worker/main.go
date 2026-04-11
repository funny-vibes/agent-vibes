package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/net/http2"
	"golang.org/x/net/proxy"
)

const (
	antigravityIDEVersion      = "1.22.2"
	loadCodeAssistCacheTTL     = 10 * time.Second
	maxRetries                 = 3
	baseDelay                  = 200 * time.Millisecond
	streamFirstChunkTimeout    = 5 * time.Minute
	streamIdleTimeout          = 5 * time.Minute
	quotaResetGraceWindow      = 1500 * time.Millisecond
	quotaResetRetryDelay       = 5 * time.Second
	maxErrorBodyBytes          = 240
	tokenRefreshSkew           = 60 * time.Second
	tokenEndpoint              = "https://oauth2.googleapis.com/token"
	stdoutScannerBufferMaxSize = 32 * 1024 * 1024
)

var (
	oauthNonGCP = oauthCredentials{
		ClientID:     "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
		ClientSecret: "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",
	}
	oauthGCPTOS = oauthCredentials{
		ClientID:     "884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com",
		ClientSecret: "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",
	}
	endpoints = struct {
		Sandbox    string
		Daily      string
		Production string
	}{
		Sandbox:    "https://daily-cloudcode-pa.sandbox.googleapis.com",
		Daily:      "https://daily-cloudcode-pa.googleapis.com",
		Production: "https://cloudcode-pa.googleapis.com",
	}
	reQuotaResetPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)quota will reset after ([^.,;\]\n]+)`),
		regexp.MustCompile(`(?i)retry after ([^.,;\]\n]+)`),
		regexp.MustCompile(`(?i)quotaResetDelay["'=:\s]+([^\s,"}\]]+)`),
	}
	retryDelayHintKeys = map[string]struct{}{
		"retryafter":        {},
		"retry_after":       {},
		"retrydelay":        {},
		"retry_delay":       {},
		"quotaresetdelay":   {},
		"quota_reset_delay": {},
		"backofflimit":      {},
		"backoff_limit":     {},
	}
)

type oauthCredentials struct {
	ClientID     string
	ClientSecret string
}

type accountConfig struct {
	Email                string `json:"email"`
	AccessToken          string `json:"accessToken"`
	RefreshToken         string `json:"refreshToken"`
	ExpiresAt            string `json:"expiresAt,omitempty"`
	ProjectID            string `json:"projectId,omitempty"`
	QuotaProjectID       string `json:"quotaProjectId,omitempty"`
	IsGCPTOS             bool   `json:"isGcpTos,omitempty"`
	CloudCodeURLOverride string `json:"cloudCodeUrlOverride,omitempty"`
	ProxyURL             string `json:"proxyUrl,omitempty"`
	IDEVersion           string `json:"ideVersion,omitempty"`
}

type workerRequest struct {
	ID     string         `json:"id"`
	Method string         `json:"method"`
	Params map[string]any `json:"params,omitempty"`
}

type workerError struct {
	Message string `json:"message"`
	Stack   string `json:"stack,omitempty"`
}

type workerResponse struct {
	Type   string         `json:"type,omitempty"`
	ID     string         `json:"id,omitempty"`
	Result any            `json:"result,omitempty"`
	Error  *workerError   `json:"error,omitempty"`
	Stream any            `json:"stream,omitempty"`
	Tokens map[string]any `json:"tokens,omitempty"`
	Pid    int            `json:"pid,omitempty"`
	UserAg string         `json:"userAgent,omitempty"`
}

type retryOptions struct {
	PreferPoolRotation bool
}

type loadCodeAssistCacheEntry struct {
	ExpiresAt time.Time
	Result    any
}

type inflightLoad struct {
	done   chan struct{}
	result any
	err    error
}

type tokenRefreshResponse struct {
	AccessToken  string `json:"access_token"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
}

type readerOnly struct {
	io.Reader
}

type workerState struct {
	stdoutMu sync.Mutex

	mu                      sync.RWMutex
	config                  *accountConfig
	httpClient              *http.Client
	endpoint                string
	cloudaicompanionProject string
	loadCodeAssistCache     map[string]loadCodeAssistCacheEntry
	loadCodeAssistInflight  map[string]*inflightLoad
	activeStreamRequests    map[string]context.CancelCauseFunc

	refreshMu sync.Mutex
}

func newWorkerState() *workerState {
	return &workerState{
		loadCodeAssistCache:    make(map[string]loadCodeAssistCacheEntry),
		loadCodeAssistInflight: make(map[string]*inflightLoad),
		activeStreamRequests:   make(map[string]context.CancelCauseFunc),
	}
}

func main() {
	worker := newWorkerState()
	worker.sendMessage(workerResponse{
		Type:   "ready",
		Pid:    os.Getpid(),
		UserAg: worker.getUserAgent(),
	})

	reader := bufio.NewReader(os.Stdin)
	for {
		line, err := readStdinLine(reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			worker.sendMessage(workerResponse{
				Error: &workerError{
					Message: fmt.Sprintf("IPC read failed: %v", err),
				},
			})
			return
		}

		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var request workerRequest
		if err := json.Unmarshal([]byte(line), &request); err != nil {
			worker.sendMessage(workerResponse{
				Error: &workerError{
					Message: fmt.Sprintf("Invalid JSON: %v", err),
				},
			})
			continue
		}
		go worker.handleRequest(request)
	}
}

func readStdinLine(reader *bufio.Reader) (string, error) {
	line, err := reader.ReadBytes('\n')
	if errors.Is(err, io.EOF) && len(line) > 0 {
		return string(line), nil
	}
	if err != nil {
		return "", err
	}
	return string(line), nil
}

func (w *workerState) handleRequest(request workerRequest) {
	result, streamHandled, err := w.dispatch(request)
	if streamHandled {
		if err != nil {
			w.sendMessage(workerResponse{
				ID: request.ID,
				Error: &workerError{
					Message: err.Error(),
					Stack:   string(debug.Stack()),
				},
			})
		}
		return
	}
	if err != nil {
		w.sendMessage(workerResponse{
			ID: request.ID,
			Error: &workerError{
				Message: err.Error(),
				Stack:   string(debug.Stack()),
			},
		})
		return
	}
	w.sendMessage(workerResponse{
		ID:     request.ID,
		Result: result,
	})
}

func (w *workerState) dispatch(request workerRequest) (any, bool, error) {
	switch request.Method {
	case "init":
		return w.handleInit(request.Params)
	case "checkAvailability":
		return w.handleCheckAvailability()
	case "generate":
		return w.handleGenerate(request.ID, request.Params)
	case "generateStream":
		return nil, true, w.handleGenerateStream(request.ID, request.Params)
	case "cancelRequest":
		return w.handleCancelRequest(request.Params)
	case "loadCodeAssist":
		return w.handleLoadCodeAssist(request.Params)
	case "fetchAvailableModels":
		return w.handleFetchAvailableModels()
	case "fetchUserInfo":
		return w.handleFetchUserInfo(request.Params)
	case "recordCodeAssistMetrics":
		return w.handleRecordCodeAssistMetrics(request.Params)
	case "recordTrajectoryAnalytics":
		return w.handleRecordTrajectoryAnalytics(request.Params)
	case "webSearch":
		return w.handleWebSearch(request.Params)
	default:
		return nil, false, fmt.Errorf("Unknown method: %s", request.Method)
	}
}

func (w *workerState) sendMessage(message workerResponse) {
	bytes, err := json.Marshal(message)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[ipc] failed to marshal message: %v\n", err)
		return
	}
	w.stdoutMu.Lock()
	defer w.stdoutMu.Unlock()
	_, _ = os.Stdout.Write(append(bytes, '\n'))
}

func (w *workerState) logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

func normalizeProxyURL(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	return trimmed
}

func sanitizeProxyURLForLog(proxyURL string) string {
	if proxyURL == "" {
		return ""
	}
	parsed, err := url.Parse(proxyURL)
	if err != nil {
		return proxyURL
	}
	if parsed.User != nil {
		username := parsed.User.Username()
		if _, ok := parsed.User.Password(); ok {
			parsed.User = url.UserPassword(username, "***")
		}
	}
	return parsed.String()
}

func selectEndpoint(account *accountConfig) string {
	if account == nil {
		return endpoints.Production
	}
	if trimmed := strings.TrimSpace(account.CloudCodeURLOverride); trimmed != "" {
		return trimmed
	}
	// The official LS defaults to the production endpoint
	// (cloudcode-pa.googleapis.com) as observed in traffic capture.
	// The daily/sandbox endpoints are only used when explicitly overridden.
	return endpoints.Production
}

func (w *workerState) buildHTTPClient(proxyURL string) (*http.Client, error) {
	transport := &http.Transport{
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   20,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
		TLSClientConfig: &tls.Config{
			NextProtos: []string{"h2", "http/1.1"},
		},
	}

	if proxyURL != "" {
		parsed, err := url.Parse(proxyURL)
		if err != nil {
			return nil, fmt.Errorf("Invalid proxy URL %s: %w", proxyURL, err)
		}
		switch parsed.Scheme {
		case "http", "https":
			transport.Proxy = http.ProxyURL(parsed)
		case "socks4", "socks5", "socks5h":
			baseDialer := &net.Dialer{Timeout: 30 * time.Second}
			dialer, err := proxy.FromURL(parsed, baseDialer)
			if err != nil {
				return nil, fmt.Errorf("Invalid proxy URL %s: %w", proxyURL, err)
			}
			transport.Proxy = nil
			transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
				return dialViaProxyContext(ctx, dialer, network, address)
			}
		default:
			return nil, fmt.Errorf("Unsupported proxy protocol: %s", parsed.Scheme)
		}
	}

	// Explicitly register HTTP/2 on the transport so that connections always
	// negotiate h2 via TLS ALPN, even when a custom DialContext is set
	// (e.g. SOCKS5 proxy).  Without this, Go silently falls back to HTTP/1.1
	// and Google's frontend (GFE) identifies the request as a "direct HTTP"
	// client rather than the IDE.  This mirrors the LS binary's use of
	// google_api/transport/http/configureHTTP2.
	if _, err := http2.ConfigureTransports(transport); err != nil {
		return nil, fmt.Errorf("failed to configure HTTP/2 transport: %w", err)
	}

	return &http.Client{Transport: transport}, nil
}

func dialViaProxyContext(ctx context.Context, dialer proxy.Dialer, network, address string) (net.Conn, error) {
	type dialResult struct {
		conn net.Conn
		err  error
	}
	done := make(chan dialResult, 1)
	go func() {
		conn, err := dialer.Dial(network, address)
		done <- dialResult{conn: conn, err: err}
	}()
	select {
	case result := <-done:
		return result.conn, result.err
	case <-ctx.Done():
		return nil, context.Cause(ctx)
	}
}

func (w *workerState) initializeClient(account accountConfig) error {
	proxyURL := normalizeProxyURL(account.ProxyURL)
	httpClient, err := w.buildHTTPClient(proxyURL)
	if err != nil {
		return err
	}

	rawProjectID := strings.TrimSpace(account.ProjectID)
	rawQuotaProjectID := strings.TrimSpace(account.QuotaProjectID)
	quotaProjectID := rawQuotaProjectID
	if quotaProjectID == "" {
		quotaProjectID = rawProjectID
	}
	cloudCodeProjectID := ""
	if rawQuotaProjectID != "" && rawProjectID != "" {
		cloudCodeProjectID = rawProjectID
	}

	account.ProxyURL = proxyURL
	account.ProjectID = cloudCodeProjectID
	account.QuotaProjectID = quotaProjectID
	if strings.TrimSpace(account.IDEVersion) == "" {
		account.IDEVersion = antigravityIDEVersion
	}

	w.mu.Lock()
	w.config = &account
	w.httpClient = httpClient
	w.endpoint = selectEndpoint(&account)
	w.cloudaicompanionProject = ""
	w.loadCodeAssistCache = make(map[string]loadCodeAssistCacheEntry)
	w.loadCodeAssistInflight = make(map[string]*inflightLoad)
	w.activeStreamRequests = make(map[string]context.CancelCauseFunc)
	w.mu.Unlock()

	if proxyURL != "" {
		w.logf("[proxy] Using Google native proxy %s", sanitizeProxyURLForLog(proxyURL))
	}
	return nil
}

func (w *workerState) handleInit(params map[string]any) (any, bool, error) {
	accountMap, ok := params["account"].(map[string]any)
	if !ok {
		return nil, false, errors.New("init requires account")
	}
	account := decodeAccountConfig(accountMap)
	if err := w.initializeClient(account); err != nil {
		return nil, false, err
	}
	w.mu.RLock()
	defer w.mu.RUnlock()
	return map[string]any{
		"status":   "ok",
		"endpoint": w.endpoint,
	}, false, nil
}

func decodeAccountConfig(input map[string]any) accountConfig {
	account := accountConfig{}
	if value, ok := input["email"].(string); ok {
		account.Email = strings.TrimSpace(value)
	}
	if value, ok := input["accessToken"].(string); ok {
		account.AccessToken = value
	}
	if value, ok := input["refreshToken"].(string); ok {
		account.RefreshToken = value
	}
	if value, ok := input["expiresAt"].(string); ok {
		account.ExpiresAt = value
	}
	if value, ok := input["projectId"].(string); ok {
		account.ProjectID = value
	}
	if value, ok := input["quotaProjectId"].(string); ok {
		account.QuotaProjectID = value
	}
	if value, ok := input["cloudCodeUrlOverride"].(string); ok {
		account.CloudCodeURLOverride = value
	}
	if value, ok := input["proxyUrl"].(string); ok {
		account.ProxyURL = value
	}
	if value, ok := input["isGcpTos"].(bool); ok {
		account.IsGCPTOS = value
	}
	if value, ok := input["ideVersion"].(string); ok {
		account.IDEVersion = value
	}
	return account
}

func (w *workerState) handleCheckAvailability() (any, bool, error) {
	if !w.isInitialized() {
		return nil, false, errors.New("Worker not initialized")
	}
	result, err := w.requestLoadCodeAssist(context.Background(), nil, true)
	if err != nil {
		return nil, false, err
	}
	w.logf(
		"[DEBUG] loadCodeAssist project=%v tier=%s paidTier=%s",
		getMapField(result, "cloudaicompanionProject"),
		summarizeTier(getMapField(result, "currentTier")),
		summarizeTier(getMapField(result, "paidTier")),
	)
	if projectID := extractCloudCodeProjectID(result); projectID != "" {
		w.mu.Lock()
		w.cloudaicompanionProject = projectID
		if w.config != nil {
			w.config.ProjectID = projectID
		}
		w.mu.Unlock()
	}
	return map[string]any{"available": true}, false, nil
}

func (w *workerState) handleGenerate(_ string, params map[string]any) (any, bool, error) {
	if !w.isInitialized() {
		return nil, false, errors.New("Worker not initialized")
	}
	payload, ok := params["payload"].(map[string]any)
	if !ok {
		return nil, false, errors.New("generate requires payload")
	}
	streamPayload := w.buildStreamPayload(payload)
	retryPolicy := parseRetryOptions(params["retryPolicy"])
	w.logf(
		"[DEBUG] streamGenerateContent request: project=%v, model=%v",
		streamPayload["project"],
		streamPayload["model"],
	)
	allParts := make([]any, 0)
	var lastFinishReason any
	var usageMetadata any

	err := w.cloudCodeStreamRequest(
		context.Background(),
		"streamGenerateContent",
		streamPayload,
		retryPolicy,
		func(chunk any) error {
			inner := unwrapResponseChunk(chunk)
			candidate := firstCandidate(inner)
			if content := mapValue(candidate, "content"); content != nil {
				if parts := sliceValue(content, "parts"); len(parts) > 0 {
					allParts = append(allParts, parts...)
				}
			}
			if finishReason := getMapField(candidate, "finishReason"); finishReason != nil {
				lastFinishReason = finishReason
			}
			if metadata := getMapField(inner, "usageMetadata"); metadata != nil {
				usageMetadata = metadata
			}
			return nil
		},
	)
	if err != nil {
		return nil, false, err
	}

	if len(allParts) == 0 {
		allParts = append(allParts, map[string]any{"text": ""})
	}

	result := map[string]any{
		"candidates": []any{
			map[string]any{
				"content": map[string]any{
					"role":  "model",
					"parts": allParts,
				},
				"finishReason": firstNonNil(lastFinishReason, "STOP"),
			},
		},
	}
	if usageMetadata != nil {
		result["usageMetadata"] = usageMetadata
	}
	return result, false, nil
}

func (w *workerState) handleGenerateStream(id string, params map[string]any) error {
	if !w.isInitialized() {
		return errors.New("Worker not initialized")
	}
	payload, ok := params["payload"].(map[string]any)
	if !ok {
		return errors.New("generateStream requires payload")
	}
	streamPayload := w.buildStreamPayload(payload)
	retryPolicy := parseRetryOptions(params["retryPolicy"])

	streamCtx, cancel := context.WithCancelCause(context.Background())
	w.mu.Lock()
	w.activeStreamRequests[id] = cancel
	w.mu.Unlock()
	defer func() {
		w.mu.Lock()
		delete(w.activeStreamRequests, id)
		w.mu.Unlock()
	}()

	w.logf(
		"[DEBUG] streamGenerateContent stream: project=%v, model=%v",
		streamPayload["project"],
		streamPayload["model"],
	)

	err := w.cloudCodeStreamRequest(
		streamCtx,
		"streamGenerateContent",
		streamPayload,
		retryPolicy,
		func(chunk any) error {
			w.sendMessage(workerResponse{
				ID:     id,
				Stream: unwrapResponseChunk(chunk),
			})
			return nil
		},
	)
	if err != nil {
		return err
	}
	w.sendMessage(workerResponse{
		ID:     id,
		Stream: nil,
	})
	return nil
}

func (w *workerState) handleCancelRequest(params map[string]any) (any, bool, error) {
	requestID := strings.TrimSpace(stringValue(params["requestId"]))
	if requestID == "" {
		return nil, false, errors.New("cancelRequest requires requestId")
	}
	reason := strings.TrimSpace(stringValue(params["reason"]))
	if reason == "" {
		reason = fmt.Sprintf("Cloud Code request %s cancelled", requestID)
	}

	w.mu.RLock()
	cancel := w.activeStreamRequests[requestID]
	w.mu.RUnlock()
	if cancel == nil {
		return map[string]any{"cancelled": false}, false, nil
	}
	cancel(errors.New(reason))
	return map[string]any{"cancelled": true}, false, nil
}

func (w *workerState) handleLoadCodeAssist(params map[string]any) (any, bool, error) {
	if !w.isInitialized() {
		return nil, false, errors.New("Worker not initialized")
	}
	useCache := true
	if forceRefresh, ok := params["forceRefresh"].(bool); ok && forceRefresh {
		useCache = false
	}
	result, err := w.requestLoadCodeAssist(context.Background(), params, useCache)
	return result, false, err
}

func (w *workerState) handleFetchAvailableModels() (any, bool, error) {
	if !w.isInitialized() {
		return nil, false, errors.New("Worker not initialized")
	}
	payload := map[string]any{"project": w.currentProjectID()}
	result, err := w.cloudCodeRequest(context.Background(), "fetchAvailableModels", payload, retryOptions{})
	return result, false, err
}

func (w *workerState) handleFetchUserInfo(params map[string]any) (any, bool, error) {
	if !w.isInitialized() {
		return nil, false, errors.New("Worker not initialized")
	}
	projectID := strings.TrimSpace(stringValue(params["projectId"]))
	if projectID == "" {
		projectID = w.currentProjectID()
	}
	payload := make(map[string]any)
	if projectID != "" {
		payload["project"] = projectID
	}
	result, err := w.cloudCodeRequest(context.Background(), "fetchUserInfo", payload, retryOptions{})
	return result, false, err
}

func (w *workerState) handleRecordCodeAssistMetrics(params map[string]any) (any, bool, error) {
	if !w.isInitialized() {
		return nil, false, errors.New("Worker not initialized")
	}
	payload, ok := params["payload"].(map[string]any)
	if !ok {
		return nil, false, errors.New("recordCodeAssistMetrics requires payload")
	}
	result, err := w.cloudCodeRequest(context.Background(), "recordCodeAssistMetrics", payload, retryOptions{})
	return result, false, err
}

func (w *workerState) handleRecordTrajectoryAnalytics(params map[string]any) (any, bool, error) {
	if !w.isInitialized() {
		return nil, false, errors.New("Worker not initialized")
	}
	payload, ok := params["payload"].(map[string]any)
	if !ok {
		return nil, false, errors.New("recordTrajectoryAnalytics requires payload")
	}
	result, err := w.cloudCodeRequest(context.Background(), "recordTrajectoryAnalytics", payload, retryOptions{})
	return result, false, err
}

func (w *workerState) handleWebSearch(params map[string]any) (any, bool, error) {
	if !w.isInitialized() {
		return nil, false, errors.New("Worker not initialized")
	}
	payload := map[string]any{
		"project":     w.currentProjectID(),
		"model":       "gemini-2.5-flash",
		"requestType": "web_search",
		"userAgent":   w.getIDEName(),
		"request": map[string]any{
			"contents": []any{
				map[string]any{
					"role": "user",
					"parts": []any{
						map[string]any{"text": stringValue(params["query"])},
					},
				},
			},
			"systemInstruction": map[string]any{
				"role": "user",
				"parts": []any{
					map[string]any{
						"text": "You are a search engine bot. You will be given a query from a user. Your task is to search the web for relevant information that will help the user. You MUST perform a web search. Do not respond or interact with the user, please respond as if they typed the query into a search bar.",
					},
				},
			},
			"tools": []any{
				map[string]any{
					"googleSearch": map[string]any{
						"enhancedContent": map[string]any{
							"imageSearch": map[string]any{
								"maxResultCount": 5,
							},
						},
					},
				},
			},
			"generationConfig": map[string]any{
				"candidateCount": 1,
			},
		},
	}
	result, err := w.cloudCodeRequest(context.Background(), "generateContent", payload, retryOptions{})
	return result, false, err
}

func (w *workerState) buildLoadCodeAssistPayload(params map[string]any) map[string]any {
	var metadata map[string]any
	if raw, ok := params["metadata"].(map[string]any); ok {
		metadata = copyMap(raw)
	} else {
		metadata = map[string]any{
			"ideType": map[bool]string{true: "JETSKI", false: "ANTIGRAVITY"}[w.isGCPTOS()],
		}
	}
	return map[string]any{"metadata": metadata}
}

func (w *workerState) requestLoadCodeAssist(ctx context.Context, params map[string]any, useCache bool) (any, error) {
	payload := w.buildLoadCodeAssistPayload(params)
	cacheKey := compactJSON(payload)

	if useCache {
		w.mu.Lock()
		if cached, ok := w.loadCodeAssistCache[cacheKey]; ok {
			if cached.ExpiresAt.After(time.Now()) {
				result := cached.Result
				w.mu.Unlock()
				return result, nil
			}
			delete(w.loadCodeAssistCache, cacheKey)
		}
		if inflight, ok := w.loadCodeAssistInflight[cacheKey]; ok {
			w.mu.Unlock()
			<-inflight.done
			return inflight.result, inflight.err
		}
		inflight := &inflightLoad{done: make(chan struct{})}
		w.loadCodeAssistInflight[cacheKey] = inflight
		w.mu.Unlock()

		result, err := w.cloudCodeRequest(ctx, "loadCodeAssist", payload, retryOptions{})
		if projectID := extractCloudCodeProjectID(result); projectID != "" {
			w.mu.Lock()
			w.cloudaicompanionProject = projectID
			if w.config != nil {
				w.config.ProjectID = projectID
			}
			w.loadCodeAssistCache[cacheKey] = loadCodeAssistCacheEntry{
				ExpiresAt: time.Now().Add(loadCodeAssistCacheTTL),
				Result:    result,
			}
			inflight.result = result
			inflight.err = err
			delete(w.loadCodeAssistInflight, cacheKey)
			close(inflight.done)
			w.mu.Unlock()
			return result, err
		}

		w.mu.Lock()
		if err == nil {
			w.loadCodeAssistCache[cacheKey] = loadCodeAssistCacheEntry{
				ExpiresAt: time.Now().Add(loadCodeAssistCacheTTL),
				Result:    result,
			}
		}
		inflight.result = result
		inflight.err = err
		delete(w.loadCodeAssistInflight, cacheKey)
		close(inflight.done)
		w.mu.Unlock()
		return result, err
	}

	result, err := w.cloudCodeRequest(ctx, "loadCodeAssist", payload, retryOptions{})
	if projectID := extractCloudCodeProjectID(result); projectID != "" {
		w.mu.Lock()
		w.cloudaicompanionProject = projectID
		if w.config != nil {
			w.config.ProjectID = projectID
		}
		w.mu.Unlock()
	}
	return result, err
}

func (w *workerState) currentProjectID() string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	if w.cloudaicompanionProject != "" {
		return w.cloudaicompanionProject
	}
	if w.config == nil {
		return ""
	}
	return strings.TrimSpace(w.config.ProjectID)
}

func (w *workerState) isGCPTOS() bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.config != nil && w.config.IsGCPTOS
}

func (w *workerState) isInitialized() bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.config != nil && w.httpClient != nil
}

func (w *workerState) getUserAgent() string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	version := antigravityIDEVersion
	ideName := "antigravity"
	if w.config != nil {
		if trimmed := strings.TrimSpace(w.config.IDEVersion); trimmed != "" {
			version = trimmed
		}
		if w.config.IsGCPTOS {
			ideName = "jetski"
		}
	}
	return fmt.Sprintf("%s/%s %s/%s", ideName, version, runtime.GOOS, runtime.GOARCH)
}

func (w *workerState) getCloudCodeUserAgent() string {
	return w.getUserAgent()
}

// getIDEName returns the IDE name for the userAgent payload field.
// Matches the LS traffic: "userAgent": "antigravity" or "jetski".
func (w *workerState) getIDEName() string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	if w.config != nil && w.config.IsGCPTOS {
		return "jetski"
	}
	return "antigravity"
}

func (w *workerState) oauthCredentials() oauthCredentials {
	w.mu.RLock()
	defer w.mu.RUnlock()
	if w.config != nil && w.config.IsGCPTOS {
		return oauthGCPTOS
	}
	return oauthNonGCP
}

func (w *workerState) ensureAccessToken(ctx context.Context) error {
	w.mu.RLock()
	config := w.config
	w.mu.RUnlock()
	if config == nil {
		return errors.New("Worker not initialized")
	}
	if !shouldRefreshToken(config) {
		return nil
	}
	return w.refreshAccessToken(ctx, false)
}

func shouldRefreshToken(config *accountConfig) bool {
	if config == nil {
		return true
	}
	if strings.TrimSpace(config.AccessToken) == "" {
		return true
	}
	expiresAt, ok := parseExpiry(config.ExpiresAt)
	if !ok {
		return true
	}
	return time.Until(expiresAt) <= tokenRefreshSkew
}

func parseExpiry(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, false
	}
	timestamp, err := time.Parse(time.RFC3339, trimmed)
	if err != nil {
		return time.Time{}, false
	}
	return timestamp, true
}

func (w *workerState) refreshAccessToken(ctx context.Context, force bool) error {
	w.refreshMu.Lock()
	defer w.refreshMu.Unlock()

	w.mu.RLock()
	config := w.config
	client := w.httpClient
	w.mu.RUnlock()
	if config == nil || client == nil {
		return errors.New("Worker not initialized")
	}
	if !force && !shouldRefreshToken(config) {
		return nil
	}
	refreshToken := strings.TrimSpace(config.RefreshToken)
	if refreshToken == "" {
		return errors.New("Missing refresh token")
	}

	creds := w.oauthCredentials()
	form := url.Values{}
	form.Set("client_id", creds.ClientID)
	form.Set("client_secret", creds.ClientSecret)
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", refreshToken)

	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		tokenEndpoint,
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("User-Agent", w.getUserAgent())

	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	bodyReader, err := wrapResponseBody(response)
	if err != nil {
		return err
	}
	defer bodyReader.Close()

	body, err := io.ReadAll(bodyReader)
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("OAuth token refresh failed: %d %s", response.StatusCode, truncateText(string(body), maxErrorBodyBytes))
	}

	var tokenResponse tokenRefreshResponse
	if err := json.Unmarshal(body, &tokenResponse); err != nil {
		return err
	}

	expiresAt := time.Now().Add(time.Duration(tokenResponse.ExpiresIn) * time.Second).UTC()
	refreshToUse := refreshToken
	if strings.TrimSpace(tokenResponse.RefreshToken) != "" {
		refreshToUse = tokenResponse.RefreshToken
	}

	w.mu.Lock()
	if w.config != nil {
		w.config.AccessToken = tokenResponse.AccessToken
		w.config.RefreshToken = refreshToUse
		w.config.ExpiresAt = expiresAt.Format(time.RFC3339)
	}
	w.mu.Unlock()

	w.sendMessage(workerResponse{
		Type: "token_refresh",
		Tokens: map[string]any{
			"accessToken":  tokenResponse.AccessToken,
			"refreshToken": refreshToUse,
			"expiresAt":    expiresAt.Format(time.RFC3339),
		},
	})
	return nil
}

func (w *workerState) doAuthorizedRequest(
	ctx context.Context,
	url string,
	body []byte,
	contentType string,
	allowRefresh bool,
	forceChunked bool,
) (*http.Response, error) {
	if err := w.ensureAccessToken(ctx); err != nil {
		return nil, err
	}

	w.mu.RLock()
	config := w.config
	client := w.httpClient
	w.mu.RUnlock()
	if config == nil || client == nil {
		return nil, errors.New("Worker not initialized")
	}

	bodyReader := io.Reader(bytes.NewReader(body))
	if forceChunked {
		bodyReader = readerOnly{Reader: bytes.NewReader(body)}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bodyReader)
	if err != nil {
		return nil, err
	}
	if forceChunked {
		request.ContentLength = -1
		request.TransferEncoding = []string{"chunked"}
	}
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("User-Agent", w.getCloudCodeUserAgent())
	request.Header.Set("Accept-Encoding", "gzip")
	request.Header.Set("Authorization", "Bearer "+config.AccessToken)
	if strings.TrimSpace(config.QuotaProjectID) != "" {
		request.Header.Set("x-goog-user-project", strings.TrimSpace(config.QuotaProjectID))
	}

	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode == http.StatusUnauthorized && allowRefresh {
		_ = response.Body.Close()
		if err := w.refreshAccessToken(ctx, true); err != nil {
			return nil, err
		}
		return w.doAuthorizedRequest(ctx, url, body, contentType, false, forceChunked)
	}
	return response, nil
}

func isSuccessfulStatus(statusCode int) bool {
	return statusCode >= 200 && statusCode < 300
}

func wrapResponseBody(response *http.Response) (io.ReadCloser, error) {
	if response == nil || response.Body == nil {
		return nil, errors.New("Cloud Code response returned no body")
	}
	if !strings.EqualFold(strings.TrimSpace(response.Header.Get("Content-Encoding")), "gzip") {
		return response.Body, nil
	}
	gzipReader, err := gzip.NewReader(response.Body)
	if err != nil {
		return nil, err
	}
	return &combinedReadCloser{
		Reader: gzipReader,
		closeFn: func() error {
			errOne := gzipReader.Close()
			errTwo := response.Body.Close()
			if errOne != nil {
				return errOne
			}
			return errTwo
		},
	}, nil
}

type combinedReadCloser struct {
	io.Reader
	closeFn func() error
}

func (c *combinedReadCloser) Close() error {
	if c.closeFn == nil {
		return nil
	}
	return c.closeFn()
}

func truncateText(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	return value[:maxBytes]
}

func readResponseText(response *http.Response) (string, error) {
	reader, err := wrapResponseBody(response)
	if err != nil {
		return "", err
	}
	defer reader.Close()
	body, err := io.ReadAll(reader)
	if err != nil {
		return "", err
	}
	return string(body), nil
}

func readJSONResponse(response *http.Response) (any, error) {
	reader, err := wrapResponseBody(response)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	body, err := io.ReadAll(reader)
	if err != nil {
		return nil, err
	}
	var decoded any
	if err := json.Unmarshal(body, &decoded); err != nil {
		return nil, err
	}
	return attachCloudCodeMeta(snakeToCamelValue(decoded), response), nil
}

func attachCloudCodeMeta(result any, response *http.Response) any {
	meta := extractCloudCodeResponseMeta(response)
	if len(meta) == 0 {
		return result
	}
	resultMap, ok := result.(map[string]any)
	if !ok {
		return result
	}
	cloned := copyMap(resultMap)
	cloned["__cloudCodeMeta"] = meta
	return cloned
}

func extractCloudCodeResponseMeta(response *http.Response) map[string]any {
	if response == nil {
		return nil
	}
	meta := make(map[string]any)
	if value := strings.TrimSpace(response.Header.Get("x-cloudaicompanion-trace-id")); value != "" {
		meta["traceId"] = value
	}
	if value := strings.TrimSpace(response.Header.Get("retry-after")); value != "" {
		meta["retryAfter"] = value
	}
	if len(meta) == 0 {
		return nil
	}
	return meta
}

func sanitizeCloudCodeErrorBodyForLog(value string) string {
	redacted := regexp.MustCompile(`(?i)("?(?:access_token|refresh_token|id_token|authorization|api_key|secret|password|proxy_url|http_proxy|https_proxy)"?\s*[:=]\s*"?)([^"\\\n,}]+)`).ReplaceAllString(value, `${1}<redacted>`)
	redacted = regexp.MustCompile(`(?i)(authorization"?\s*[:=]\s*"?bearer\s+)([^"\\\s]+)`).ReplaceAllString(redacted, `${1}<redacted>`)
	return truncateText(strings.TrimSpace(redacted), 1000)
}

func buildCloudCodeError(apiMethod string, response *http.Response, errorText string, kind string) error {
	meta := extractCloudCodeResponseMeta(response)
	annotations := make([]string, 0, len(meta))
	if retryAfter, ok := meta["retryAfter"].(string); ok && retryAfter != "" {
		annotations = append(annotations, fmt.Sprintf("retry-after=%s", retryAfter))
	}
	if traceID, ok := meta["traceId"].(string); ok && traceID != "" {
		annotations = append(annotations, fmt.Sprintf("trace-id=%s", traceID))
	}
	suffix := ""
	if len(annotations) > 0 {
		suffix = " [" + strings.Join(annotations, " ") + "]"
	}
	sanitizedBody := sanitizeCloudCodeErrorBodyForLog(errorText)
	return fmt.Errorf(
		"Cloud Code %s %s: %d%s %s",
		apiMethod,
		kind,
		response.StatusCode,
		suffix,
		sanitizedBody,
	)
}

func parseDurationMS(value string) (time.Duration, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, false
	}

	re := regexp.MustCompile(`(?i)([\d.]+)\s*(ms|s|m|h)`)
	matches := re.FindAllStringSubmatch(trimmed, -1)
	if len(matches) == 0 {
		return 0, false
	}
	var total time.Duration
	for _, match := range matches {
		amount, err := strconv.ParseFloat(match[1], 64)
		if err != nil {
			continue
		}
		switch strings.ToLower(match[2]) {
		case "ms":
			total += time.Duration(amount * float64(time.Millisecond))
		case "s":
			total += time.Duration(amount * float64(time.Second))
		case "m":
			total += time.Duration(amount * float64(time.Minute))
		case "h":
			total += time.Duration(amount * float64(time.Hour))
		}
	}
	return total, true
}

func parseRetryAfterMS(value string) (time.Duration, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, false
	}
	if seconds, err := strconv.ParseFloat(trimmed, 64); err == nil {
		return time.Duration(seconds * float64(time.Second)), true
	}
	retryAt, err := http.ParseTime(trimmed)
	if err != nil {
		return 0, false
	}
	duration := time.Until(retryAt)
	if duration < 0 {
		return 0, true
	}
	return duration, true
}

func extractQuotaResetDelayMS(errorText string) (time.Duration, bool) {
	for _, pattern := range reQuotaResetPatterns {
		matches := pattern.FindStringSubmatch(errorText)
		if len(matches) < 2 {
			continue
		}
		if duration, ok := parseDurationMS(matches[1]); ok {
			return duration, true
		}
	}
	return 0, false
}

func parseFloatLike(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case uint:
		return float64(typed), true
	case uint32:
		return float64(typed), true
	case uint64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func parseStructuredDurationValue(value any) (time.Duration, bool) {
	switch typed := value.(type) {
	case string:
		if duration, ok := parseDurationMS(typed); ok {
			return duration, true
		}
		if duration, ok := parseRetryAfterMS(typed); ok {
			return duration, true
		}
	case map[string]any:
		secondsRaw, hasSeconds := typed["seconds"]
		if !hasSeconds {
			secondsRaw, hasSeconds = typed["Seconds"]
		}
		nanosRaw, hasNanos := typed["nanos"]
		if !hasNanos {
			nanosRaw, hasNanos = typed["Nanos"]
		}
		if hasSeconds || hasNanos {
			seconds := 0.0
			nanos := 0.0
			if parsed, ok := parseFloatLike(secondsRaw); ok {
				seconds = parsed
			}
			if parsed, ok := parseFloatLike(nanosRaw); ok {
				nanos = parsed
			}
			total := time.Duration(seconds*float64(time.Second) + nanos*float64(time.Nanosecond))
			if total < 0 {
				return 0, true
			}
			return total, true
		}
	}
	return 0, false
}

func extractStructuredRetryDelayMSFromValue(value any, depth int) (time.Duration, bool) {
	if depth > 8 || value == nil {
		return 0, false
	}
	if duration, ok := parseStructuredDurationValue(value); ok {
		return duration, true
	}
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			if duration, ok := extractStructuredRetryDelayMSFromValue(item, depth+1); ok {
				return duration, true
			}
		}
	case map[string]any:
		for rawKey, child := range typed {
			normalizedKey := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(rawKey)), "-", "_")
			compactKey := strings.ReplaceAll(normalizedKey, "_", "")
			if _, ok := retryDelayHintKeys[normalizedKey]; ok {
				if duration, ok := parseStructuredDurationValue(child); ok {
					return duration, true
				}
			}
			if _, ok := retryDelayHintKeys[compactKey]; ok {
				if duration, ok := parseStructuredDurationValue(child); ok {
					return duration, true
				}
			}
			if duration, ok := extractStructuredRetryDelayMSFromValue(child, depth+1); ok {
				return duration, true
			}
		}
	}
	return 0, false
}

func extractStructuredRetryDelayMS(errorText string) (time.Duration, bool) {
	trimmed := strings.TrimSpace(errorText)
	if trimmed == "" || (!strings.HasPrefix(trimmed, "{") && !strings.HasPrefix(trimmed, "[")) {
		return 0, false
	}
	var decoded any
	if err := json.Unmarshal([]byte(trimmed), &decoded); err != nil {
		return 0, false
	}
	return extractStructuredRetryDelayMSFromValue(decoded, 0)
}

func getCloudCodeRetryDelayMS(response *http.Response, errorText string) (time.Duration, bool) {
	if duration, ok := parseRetryAfterMS(response.Header.Get("retry-after")); ok {
		return duration, true
	}
	if duration, ok := extractStructuredRetryDelayMS(errorText); ok {
		return duration, true
	}
	return extractQuotaResetDelayMS(errorText)
}

func isQuotaExhausted(errorText string) bool {
	return strings.Contains(errorText, "QUOTA_EXHAUSTED") || strings.Contains(errorText, "exhausted your capacity")
}

func isModelCapacityExhausted(errorText string) bool {
	normalized := strings.ToLower(errorText)
	return strings.Contains(normalized, "model_capacity_exhausted") ||
		strings.Contains(normalized, "no capacity available for model")
}

func shouldGraceRetryQuotaExhausted(response *http.Response, errorText string) bool {
	if !isQuotaExhausted(errorText) || response == nil {
		return false
	}
	delay, ok := getCloudCodeRetryDelayMS(response, errorText)
	return ok && delay <= quotaResetGraceWindow
}

func shouldBypassLocalRetry(statusCode int, errorText string, options retryOptions) bool {
	if !options.PreferPoolRotation {
		return false
	}
	if statusCode == http.StatusTooManyRequests && isQuotaExhausted(errorText) {
		return true
	}
	if statusCode == http.StatusServiceUnavailable && isModelCapacityExhausted(errorText) {
		return true
	}
	return false
}

func shouldRetryCloudCodeStatus(statusCode int) bool {
	return statusCode == http.StatusTooManyRequests || statusCode == http.StatusServiceUnavailable
}

func sleepWithContext(ctx context.Context, duration time.Duration) error {
	if duration <= 0 {
		return nil
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return normalizeAbortReason("streamGenerateContent", ctx, "stream aborted")
	}
}

func normalizeAbortReason(apiMethod string, ctx context.Context, fallbackLabel string) error {
	if ctx == nil {
		return fmt.Errorf("Cloud Code %s %s", apiMethod, fallbackLabel)
	}
	cause := context.Cause(ctx)
	if cause != nil {
		return cause
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return fmt.Errorf("Cloud Code %s %s", apiMethod, fallbackLabel)
}

func (w *workerState) cloudCodeRequest(
	ctx context.Context,
	apiMethod string,
	payload any,
	options retryOptions,
) (any, error) {
	var lastErr error
	var retryDelay time.Duration

	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			delay := retryDelay
			if delay <= 0 {
				delay = time.Duration(1<<(attempt-1)) * baseDelay
			}
			retryDelay = 0
			w.logf("[worker-local-retry] %s attempt %d/%d after %dms", apiMethod, attempt+1, maxRetries+1, delay.Milliseconds())
			if err := sleepWithContext(ctx, delay); err != nil {
				return nil, err
			}
		}

		body, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		url := fmt.Sprintf("%s/v1internal:%s", w.currentEndpoint(), apiMethod)
		response, err := w.doAuthorizedRequest(
			ctx,
			url,
			body,
			"application/json",
			true,
			false,
		)
		if err != nil {
			lastErr = err
			if attempt == maxRetries {
				break
			}
			continue
		}

		if isSuccessfulStatus(response.StatusCode) {
			defer response.Body.Close()
			return readJSONResponse(response)
		}

		errorText, readErr := readResponseText(response)
		if readErr != nil {
			_ = response.Body.Close()
			lastErr = readErr
			if attempt == maxRetries {
				break
			}
			continue
		}
		lastErr = buildCloudCodeError(apiMethod, response, errorText, "failed")
		if shouldBypassLocalRetry(response.StatusCode, errorText, options) {
			return nil, lastErr
		}
		if response.StatusCode == http.StatusTooManyRequests && isQuotaExhausted(errorText) {
			if attempt < maxRetries && shouldGraceRetryQuotaExhausted(response, errorText) {
				retryDelay = quotaResetRetryDelay
				w.logf("[worker-local-retry] %s quota reset is imminent; retrying in %dms", apiMethod, retryDelay.Milliseconds())
				continue
			}
			return nil, lastErr
		}
		if !shouldRetryCloudCodeStatus(response.StatusCode) {
			return nil, lastErr
		}
		if delay, ok := getCloudCodeRetryDelayMS(response, errorText); ok {
			retryDelay = delay
		}
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("Cloud Code %s failed", apiMethod)
	}
	return nil, lastErr
}

func (w *workerState) cloudCodeStreamRequest(
	ctx context.Context,
	apiMethod string,
	payload any,
	options retryOptions,
	onChunk func(chunk any) error,
) error {
	var lastErr error
	var retryDelay time.Duration

	for attempt := 0; attempt <= maxRetries; attempt++ {
		if ctx.Err() != nil {
			return normalizeAbortReason(apiMethod, ctx, "stream aborted")
		}
		if attempt > 0 {
			delay := retryDelay
			if delay <= 0 {
				delay = time.Duration(1<<(attempt-1)) * baseDelay
			}
			retryDelay = 0
			w.logf("[worker-local-retry] %s stream attempt %d/%d after %dms", apiMethod, attempt+1, maxRetries+1, delay.Milliseconds())
			if err := sleepWithContext(ctx, delay); err != nil {
				return err
			}
		}

		body, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		w.logf("[DEBUG] %s payload: %s", apiMethod, summarizeStreamPayload(payload, len(body)))

		requestCtx, cancel := context.WithCancelCause(ctx)
		timeout := newStreamInactivityTimeout(cancel, apiMethod)
		timeout.Reset(streamFirstChunkTimeout, "first chunk")

		url := fmt.Sprintf("%s/v1internal:%s?alt=sse", w.currentEndpoint(), apiMethod)
		response, err := w.doAuthorizedRequest(
			requestCtx,
			url,
			body,
			"application/json",
			true,
			true,
		)
		if err != nil {
			timeout.Stop()
			cancel(nil)
			if ctx.Err() != nil {
				return normalizeAbortReason(apiMethod, ctx, "stream aborted")
			}
			if context.Cause(requestCtx) != nil {
				lastErr = normalizeAbortReason(apiMethod, requestCtx, "stream aborted")
			} else {
				lastErr = err
			}
			if attempt == maxRetries {
				break
			}
			continue
		}

		if isSuccessfulStatus(response.StatusCode) {
			if meta := extractCloudCodeResponseMeta(response); len(meta) > 0 {
				if traceID, ok := meta["traceId"].(string); ok && traceID != "" {
					if err := onChunk(map[string]any{
						"__cloudCodeMeta": map[string]any{
							"traceId": traceID,
						},
					}); err != nil {
						timeout.Stop()
						_ = response.Body.Close()
						cancel(nil)
						return err
					}
				}
			}

			reader, err := wrapResponseBody(response)
			if err != nil {
				timeout.Stop()
				_ = response.Body.Close()
				cancel(nil)
				lastErr = err
				if attempt == maxRetries {
					break
				}
				continue
			}

			scanner := bufio.NewScanner(reader)
			scanner.Buffer(make([]byte, 0, 64*1024), stdoutScannerBufferMaxSize)
			for scanner.Scan() {
				timeout.Reset(streamIdleTimeout, "idle")
				line := strings.TrimSpace(scanner.Text())
				if line == "" || strings.HasPrefix(line, ":") {
					continue
				}
				if !strings.HasPrefix(line, "data: ") {
					continue
				}
				payload := strings.TrimSpace(strings.TrimPrefix(line, "data: "))
				if payload == "[DONE]" {
					timeout.Stop()
					_ = reader.Close()
					cancel(nil)
					return nil
				}
				var decoded any
				if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
					continue
				}
				if err := onChunk(snakeToCamelValue(decoded)); err != nil {
					timeout.Stop()
					_ = reader.Close()
					cancel(nil)
					return err
				}
			}
			scanErr := scanner.Err()
			timeout.Stop()
			_ = reader.Close()
			cancel(nil)
			if scanErr == nil {
				return nil
			}
			if ctx.Err() != nil || context.Cause(requestCtx) != nil {
				lastErr = normalizeAbortReason(apiMethod, requestCtx, "stream aborted")
			} else {
				lastErr = scanErr
			}
			if attempt == maxRetries {
				break
			}
			continue
		}

		timeout.Stop()
		errorText, readErr := readResponseText(response)
		cancel(nil)
		if readErr != nil {
			lastErr = readErr
			if attempt == maxRetries {
				break
			}
			continue
		}
		lastErr = buildCloudCodeError(apiMethod, response, errorText, "stream failed")
		if shouldBypassLocalRetry(response.StatusCode, errorText, options) {
			return lastErr
		}
		if response.StatusCode == http.StatusTooManyRequests && isQuotaExhausted(errorText) {
			if attempt < maxRetries && shouldGraceRetryQuotaExhausted(response, errorText) {
				retryDelay = quotaResetRetryDelay
				w.logf("[worker-local-retry] %s stream quota reset is imminent; retrying in %dms", apiMethod, retryDelay.Milliseconds())
				continue
			}
			return lastErr
		}
		if !shouldRetryCloudCodeStatus(response.StatusCode) {
			return lastErr
		}
		if delay, ok := getCloudCodeRetryDelayMS(response, errorText); ok {
			retryDelay = delay
		}
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("Cloud Code %s stream failed", apiMethod)
	}
	return lastErr
}

type streamInactivityTimeout struct {
	mu        sync.Mutex
	timer     *time.Timer
	cancel    context.CancelCauseFunc
	apiMethod string
}

func newStreamInactivityTimeout(cancel context.CancelCauseFunc, apiMethod string) *streamInactivityTimeout {
	return &streamInactivityTimeout{
		cancel:    cancel,
		apiMethod: apiMethod,
	}
}

func (s *streamInactivityTimeout) Reset(duration time.Duration, label string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		s.timer.Stop()
	}
	s.timer = time.AfterFunc(duration, func() {
		s.cancel(fmt.Errorf("Cloud Code %s %s timeout after %dms", s.apiMethod, label, duration.Milliseconds()))
	})
}

func (s *streamInactivityTimeout) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
}

func (w *workerState) currentEndpoint() string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	if strings.TrimSpace(w.endpoint) == "" {
		return endpoints.Production
	}
	return w.endpoint
}

func parseRetryOptions(raw any) retryOptions {
	result := retryOptions{}
	retryPolicy, ok := raw.(map[string]any)
	if !ok {
		return result
	}
	if value, ok := retryPolicy["preferPoolRotation"].(bool); ok {
		result.PreferPoolRotation = value
	}
	return result
}

func (w *workerState) buildStreamPayload(incomingPayload map[string]any) map[string]any {
	request, ok := incomingPayload["request"].(map[string]any)
	if ok && (request["contents"] != nil || request["systemInstruction"] != nil) {
		payload := copyMap(incomingPayload)
		if projectID := w.currentProjectID(); projectID != "" {
			payload["project"] = projectID
		}
		if strings.TrimSpace(stringValue(payload["requestId"])) == "" {
			payload["requestId"] = fmt.Sprintf("agent/%d/%s", time.Now().UnixMilli(), randomID())
		}
		// Inject LS-matching fields if not already present (verified via traffic capture)
		if payload["userAgent"] == nil {
			payload["userAgent"] = w.getIDEName()
		}
		if payload["requestType"] == nil {
			payload["requestType"] = "agent"
		}
		if payload["enabledCreditTypes"] == nil {
			payload["enabledCreditTypes"] = []string{"GOOGLE_ONE_AI"}
		}
		return payload
	}

	payload := map[string]any{
		"project":            firstNonEmptyString(w.currentProjectID(), stringValue(incomingPayload["project"])),
		"requestId":          fmt.Sprintf("agent/%d/%s", time.Now().UnixMilli(), randomID()),
		"userAgent":          w.getIDEName(),
		"requestType":        "agent",
		"enabledCreditTypes": []string{"GOOGLE_ONE_AI"},
		"request":            map[string]any{},
	}
	if model := incomingPayload["model"]; model != nil {
		payload["model"] = model
	}

	inner := map[string]any{}
	for _, key := range []string{"contents", "systemInstruction", "tools", "generationConfig", "toolConfig", "sessionId"} {
		if value, ok := incomingPayload[key]; ok {
			inner[key] = value
		}
	}
	payload["request"] = inner
	return payload
}

func randomID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer)
}

func copyMap(input map[string]any) map[string]any {
	cloned := make(map[string]any, len(input))
	for key, value := range input {
		cloned[key] = value
	}
	return cloned
}

func extractCloudCodeProjectID(result any) string {
	resultMap, ok := result.(map[string]any)
	if !ok {
		return ""
	}
	if value, ok := resultMap["cloudaicompanionProject"].(string); ok {
		return strings.TrimSpace(value)
	}
	return ""
}

func getMapField(value any, key string) any {
	resultMap, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return resultMap[key]
}

func summarizeTier(value any) string {
	resultMap, ok := value.(map[string]any)
	if !ok {
		return compactJSON(value)
	}
	parts := make([]string, 0, 2)
	if id := strings.TrimSpace(stringValue(resultMap["id"])); id != "" {
		parts = append(parts, "id="+id)
	}
	if name := strings.TrimSpace(stringValue(resultMap["name"])); name != "" {
		parts = append(parts, "name="+name)
	}
	if len(parts) == 0 {
		return compactJSON(value)
	}
	return strings.Join(parts, ",")
}

func summarizeStreamPayload(payload any, bodyBytes int) string {
	resultMap, ok := payload.(map[string]any)
	if !ok {
		return fmt.Sprintf("%d bytes", bodyBytes)
	}
	request := mapValue(resultMap, "request")
	contentsCount := 0
	if contents := sliceValue(request, "contents"); contents != nil {
		contentsCount = len(contents)
	}
	return fmt.Sprintf(
		"project=%v model=%v requestId=%v contents=%d bytes=%d",
		resultMap["project"],
		resultMap["model"],
		resultMap["requestId"],
		contentsCount,
		bodyBytes,
	)
}

func compactJSON(value any) string {
	if value == nil {
		return "null"
	}
	bytes, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	return string(bytes)
}

func stringValue(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprintf("%v", value)
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func firstNonNil(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func unwrapResponseChunk(chunk any) any {
	chunkMap, ok := chunk.(map[string]any)
	if !ok {
		return chunk
	}
	if response, ok := chunkMap["response"]; ok {
		return response
	}
	return chunk
}

func firstCandidate(chunk any) map[string]any {
	chunkMap, ok := chunk.(map[string]any)
	if !ok {
		return nil
	}
	candidates, ok := chunkMap["candidates"].([]any)
	if !ok || len(candidates) == 0 {
		return nil
	}
	candidate, _ := candidates[0].(map[string]any)
	return candidate
}

func mapValue(input map[string]any, key string) map[string]any {
	if input == nil {
		return nil
	}
	value, _ := input[key].(map[string]any)
	return value
}

func sliceValue(input map[string]any, key string) []any {
	if input == nil {
		return nil
	}
	value, _ := input[key].([]any)
	return value
}

func snakeToCamelValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, inner := range typed {
			result[snakeToCamelKey(key)] = snakeToCamelValue(inner)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for index, inner := range typed {
			result[index] = snakeToCamelValue(inner)
		}
		return result
	default:
		return value
	}
}

func snakeToCamelKey(key string) string {
	if !strings.Contains(key, "_") {
		return key
	}
	var builder strings.Builder
	upperNext := false
	for _, char := range key {
		if char == '_' {
			upperNext = true
			continue
		}
		if upperNext {
			builder.WriteRune(unicode.ToUpper(char))
			upperNext = false
			continue
		}
		builder.WriteRune(char)
	}
	return builder.String()
}
