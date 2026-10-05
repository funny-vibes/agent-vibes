/** Browser client: signaling, native events, Web conversation binding and cleanup. */
export async function connectGptRealtime({
  baseUrl,
  token,
  provider,
  model = provider === "codex" ? "gpt-live-1-codex" : "gpt-realtime",
  voice = "cove",
  historyPolicy = "disabled",
  stream,
  audioElement,
  onEvent = () => {},
}) {
  const base = new URL(baseUrl)
  const pc = new RTCPeerConnection()
  const dc = pc.createDataChannel(
    "oai-events",
    provider === "chatgpt-web" ? { negotiated: true, id: 0 } : {}
  )
  let location
  let conversationId
  let binding = Promise.resolve()
  let closing
  let closed = false
  let resolveReady, rejectReady
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // Callers can await ready; a signaling-only caller need not handle a rejection.
  ready.catch(() => {})
  const request = async (url, method, body) => {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok) throw new Error(await response.text())
    return response
  }
  const close = () => {
    if (closing) return closing
    closed = true
    pc.close()
    rejectReady(new Error("Call closed before readiness"))
    closing = (async () => {
      if (!location) return
      await binding.catch(async (error) => {
        if (!conversationId) throw error
        await request(location, "PATCH", { conversation_id: conversationId })
      })
      return (await request(location, "DELETE")).json()
    })().finally(() => {
      closing = undefined
    })
    return closing
  }
  const onClosed = () => {
    if (!closed)
      close().catch((error) => onEvent({ type: "cleanup.error", error }))
  }
  pc.onconnectionstatechange = () => {
    onEvent({ type: "connection.state", state: pc.connectionState })
    if (pc.connectionState === "failed") onClosed()
  }
  pc.ontrack = (event) => {
    const remote = new MediaStream([event.track])
    if (audioElement) {
      audioElement.srcObject = remote
      audioElement
        .play()
        .catch((error) => onEvent({ type: "playback.error", error }))
    }
    onEvent({ type: "remote.track", stream: remote })
  }
  dc.onclose = onClosed
  dc.onmessage = (event) => {
    let message
    try {
      message = JSON.parse(event.data)
      if (provider === "chatgpt-web" && message.type === "data_message") {
        message = JSON.parse(message.data)
      }
    } catch (error) {
      onEvent({ type: "protocol.error", error })
      return
    }
    if (message.type === "error")
      rejectReady(new Error(message.error?.message ?? "Voice session failed"))
    const payload = message.payload ?? message
    if (
      provider === "chatgpt-web" &&
      ["startup_telemetry", "conversation_update"].includes(message.type) &&
      payload.conversation_id &&
      !conversationId
    ) {
      conversationId = payload.conversation_id
      binding = binding.then(async () => {
        await request(location, "PATCH", { conversation_id: conversationId })
      })
      binding.catch((error) => onEvent({ type: "binding.error", error }))
    }
    if (
      message.type === "session.started" ||
      (message.type === "startup_telemetry" && payload.success === true)
    ) {
      binding.then(() => resolveReady(), rejectReady)
    }
    onEvent(message)
  }
  try {
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream)
    await pc.setLocalDescription(await pc.createOffer())
    await new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve()
      const timer = setTimeout(resolve, 4000)
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timer)
          resolve()
        }
      }
    })
    const response = await request(
      new URL("/v1/realtime/calls", base),
      "POST",
      {
        provider,
        history_policy: historyPolicy,
        sdp: pc.localDescription.sdp,
        session: { model, voice },
      }
    )
    const resource = response.headers.get("Location")
    if (!resource) throw new Error("Signaling response omitted Location")
    location = new URL(resource, base)
    if (location.origin !== base.origin)
      throw new Error("Unexpected call resource origin")
    await pc.setRemoteDescription({
      type: "answer",
      sdp: await response.text(),
    })
    return { id: location.pathname.split("/").at(-1), pc, dc, ready, close }
  } catch (error) {
    pc.close()
    rejectReady(error)
    throw error
  }
}
