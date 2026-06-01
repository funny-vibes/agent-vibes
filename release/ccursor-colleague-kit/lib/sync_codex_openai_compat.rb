#!/usr/bin/env ruby
# frozen_string_literal: true

require "fileutils"
require "json"
require "optparse"
require "time"

DEFAULT_MODEL = "gpt-5.5"
DEFAULT_CONTEXT_TOKENS = 200_000
DEFAULT_PREFER_RESPONSES_API = false
MANAGED_BY = "ccursor-colleague-kit"

options = {
  check_only: false,
  dry_run: false,
  json: false
}

OptionParser.new do |parser|
  parser.on("--check-only", "Parse Codex config without writing CCursor config") do
    options[:check_only] = true
  end
  parser.on("--dry-run", "Show what would be written without changing files") do
    options[:dry_run] = true
  end
  parser.on("--json", "Print machine-readable JSON summary") do
    options[:json] = true
  end
end.parse!

def fail_with(message)
  warn "ERROR: #{message}"
  exit 1
end

def strip_inline_comment(line)
  quote = nil
  escaped = false
  output = +""

  line.each_char do |char|
    if escaped
      output << char
      escaped = false
      next
    end

    if quote == "\"" && char == "\\"
      output << char
      escaped = true
      next
    end

    if quote
      quote = nil if char == quote
      output << char
      next
    end

    if char == "\"" || char == "'"
      quote = char
      output << char
      next
    end

    break if char == "#"

    output << char
  end

  output.strip
end

def parse_toml_value(raw_value)
  value = strip_inline_comment(raw_value).strip

  if value.start_with?("\"") && value.end_with?("\"")
    return value[1...-1].gsub("\\\"", "\"").gsub("\\\\", "\\")
  end

  if value.start_with?("'") && value.end_with?("'")
    return value[1...-1]
  end

  return true if value == "true"
  return false if value == "false"
  return value.to_i if value.match?(/\A-?\d+\z/)

  value
end

def parse_codex_config(path)
  data = { "model_providers" => {} }
  section = []

  File.readlines(path, chomp: true).each do |line|
    cleaned = strip_inline_comment(line)
    next if cleaned.empty?

    if (match = cleaned.match(/\A\[([^\]]+)\]\z/))
      section = match[1].split(".").map(&:strip)
      next
    end

    match = cleaned.match(/\A([A-Za-z0-9_.-]+)\s*=\s*(.+)\z/)
    next unless match

    key = match[1]
    value = parse_toml_value(match[2])

    if section.length == 2 && section[0] == "model_providers"
      provider = section[1]
      data["model_providers"][provider] ||= {}
      data["model_providers"][provider][key] = value
    elsif section.empty?
      data[key] = value
    end
  end

  data
end

def find_provider(config)
  providers = config.fetch("model_providers", {})
  configured_name = config["model_provider"].to_s.strip

  if !configured_name.empty? && providers.key?(configured_name)
    return [configured_name, providers[configured_name]]
  end

  providers.each do |name, provider|
    base_url = provider["base_url"] || provider["baseUrl"]
    return [name, provider] if base_url.to_s.strip != ""
  end

  fail_with("No usable [model_providers.<name>] entry with base_url found in Codex config")
end

def resolve_api_key(provider)
  direct_key_fields = %w[
    api_key
    apiKey
    bearer_token
    bearerToken
    experimental_bearer_token
    token
  ]

  direct_key_fields.each do |field|
    value = provider[field].to_s.strip
    next if value.empty?

    if value.start_with?("env:")
      env_name = value.sub(/\Aenv:/, "").strip
      env_value = ENV.fetch(env_name, "").strip
      return [env_value, "env:#{env_name}"] unless env_value.empty?
      fail_with("Codex provider references #{env_name}, but that environment variable is empty")
    end

    return [value, field]
  end

  %w[env_key api_key_env apiKeyEnv].each do |field|
    env_name = provider[field].to_s.strip
    next if env_name.empty?

    env_value = ENV.fetch(env_name, "").strip
    return [env_value, "env:#{env_name}"] unless env_value.empty?
    fail_with("Codex provider references #{env_name}, but that environment variable is empty")
  end

  fail_with("No api_key/apiKey/experimental_bearer_token/env_key found for the selected Codex provider")
end

def load_existing_accounts(path)
  return { "accounts" => [] } unless File.exist?(path)

  parsed = JSON.parse(File.read(path))
  parsed["accounts"] = [] unless parsed["accounts"].is_a?(Array)
  parsed
rescue JSON::ParserError
  { "accounts" => [] }
end

codex_home = ENV.fetch("CODEX_HOME", File.join(Dir.home, ".codex"))
codex_config_path = File.join(codex_home, "config.toml")
fail_with("Codex config not found at #{codex_config_path}") unless File.exist?(codex_config_path)

config = parse_codex_config(codex_config_path)
provider_name, provider = find_provider(config)
base_url = (provider["base_url"] || provider["baseUrl"]).to_s.strip
fail_with("Selected Codex provider #{provider_name} has empty base_url") if base_url.empty?

api_key, key_source = resolve_api_key(provider)
model = config["model"].to_s.strip
model = provider["model"].to_s.strip if model.empty?
model = DEFAULT_MODEL if model.empty?
allowed_models = [model.downcase.strip].reject(&:empty?)

label = "codex-#{provider_name}"
account = {
  "label" => label,
  "apiKey" => api_key,
  "baseUrl" => base_url,
  "preferResponsesApi" => DEFAULT_PREFER_RESPONSES_API,
  "maxContextTokens" => DEFAULT_CONTEXT_TOKENS,
  "managedBy" => MANAGED_BY,
  "sourceProvider" => provider_name,
  "sourceModel" => model,
  "allowedModels" => allowed_models
}

ccursor_home = ENV.fetch("CCURSOR_HOME", File.join(Dir.home, ".ccursor"))
dest_path = ENV.fetch(
  "CCURSOR_OPENAI_COMPAT_ACCOUNTS_PATH",
  File.join(ccursor_home, "data", "openai-compat-accounts.json")
)

existing = load_existing_accounts(dest_path)
accounts = existing["accounts"]
index = accounts.find_index do |item|
  item.is_a?(Hash) &&
    (item["managedBy"] == MANAGED_BY || item["label"] == label)
end

if index
  accounts[index] = account
else
  accounts << account
end

summary = {
  "codexConfig" => codex_config_path,
  "provider" => provider_name,
  "model" => model,
  "baseUrl" => base_url,
  "keySource" => key_source,
  "apiKey" => "[hidden]",
  "destination" => dest_path,
  "accountLabel" => label,
  "allowedModels" => allowed_models,
  "preferResponsesApi" => DEFAULT_PREFER_RESPONSES_API,
  "protocol" => "chat_completions",
  "wouldWrite" => !(options[:check_only] || options[:dry_run])
}

unless options[:check_only] || options[:dry_run]
  FileUtils.mkdir_p(File.dirname(dest_path))
  if File.exist?(dest_path)
    backup_path = "#{dest_path}.bak.#{Time.now.utc.strftime("%Y%m%d%H%M%S")}"
    FileUtils.cp(dest_path, backup_path)
    summary["backup"] = backup_path
  end
  File.write(dest_path, JSON.pretty_generate(existing) + "\n", mode: "w", perm: 0o600)
  File.chmod(0o600, dest_path)
end

if options[:json]
  puts JSON.pretty_generate(summary)
else
  puts "Codex config: #{summary["codexConfig"]}"
  puts "Provider: #{summary["provider"]}"
  puts "Model: #{summary["model"]}"
  puts "Base URL: #{summary["baseUrl"]}"
  puts "API key: #{summary["apiKey"]} (#{summary["keySource"]})"
  puts "CCursor account: #{summary["accountLabel"]}"
  puts "Allowed models: #{summary["allowedModels"].join(", ")}"
  puts "Protocol: Chat Completions (preferResponsesApi=#{summary["preferResponsesApi"]})"
  puts "Destination: #{summary["destination"]}"
  puts "Backup: #{summary["backup"]}" if summary["backup"]
  puts(options[:check_only] || options[:dry_run] ? "Mode: check only" : "Synced: yes")
end
