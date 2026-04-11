import type { CloudCodeToolDeclaration } from "./cloud-code"

interface ToolDefinitionLike {
  name?: unknown
}

interface OfficialAntigravityToolCapabilityContext {
  available: Set<string>
  hasEditCapability: boolean
  hasRunCommandCapability: boolean
  hasSendCommandInputCapability: boolean
  hasCommandStatusCapability: boolean
  hasGenerateImageCapability: boolean
}

interface OfficialAntigravityToolDeclarationDefinition {
  name: string
  description: string
  properties: Record<string, unknown>
  required: string[]
  isEnabled: (context: OfficialAntigravityToolCapabilityContext) => boolean
}

export interface OfficialAntigravityCanonicalToolInvocation {
  toolName: string
  input: Record<string, unknown>
  historyToolName?: string
  historyToolInput?: Record<string, unknown>
  validationErrorMessage?: string
}

interface OfficialAntigravityNormalizedEditChunk {
  allowMultiple?: boolean
  targetContent?: string
  replacementContent?: string
  startLine?: number
  endLine?: number
}

export type OfficialAntigravityArtifactType =
  | "implementation_plan"
  | "walkthrough"
  | "task"
  | "other"

export interface OfficialAntigravityArtifactMetadata {
  artifactType: OfficialAntigravityArtifactType
  requestFeedback?: boolean
  summary?: string
}

const TOOL_ACTION_DESCRIPTION =
  "Brief 2-5 word summary of what this tool is doing. Capitalize like a sentence. Some examples: 'Analyzing directory', 'Searching the web', 'Editing file', 'Viewing file', 'Running command', 'Semantic searching'."
const TOOL_SUMMARY_DESCRIPTION =
  "Brief 2-5 word noun phrase describing what this tool call is about. Capitalize like a sentence. Some examples: 'Directory analysis', 'Web search', 'File edit', 'Command execution', 'Semantic search'."
const WAIT_FOR_PREVIOUS_TOOLS_DESCRIPTION =
  "If true, wait for all previous tool calls from this turn to complete before executing (sequential). If false or omitted, execute this tool immediately (parallel with other tools)."

const ARTIFACT_METADATA_PROPERTIES: Record<string, unknown> = {
  ArtifactType: {
    type: "STRING",
    description:
      "Type of artifact: 'implementation_plan', 'walkthrough', 'task', or 'other'.",
    enum: ["implementation_plan", "walkthrough", "task", "other"],
  },
  RequestFeedback: {
    type: "BOOLEAN",
    description: "Set to true to request user feedback on this artifact.",
  },
  Summary: {
    type: "STRING",
    description:
      "Detailed multi-line summary of the artifact file, after edits have been made. Summary does not need to mention the artifact name and should focus on the contents and purpose of the artifact.",
  },
}

const ARTIFACT_METADATA_REQUIRED = ["Summary", "ArtifactType"]

const REPLACEMENT_CHUNK_PROPERTIES: Record<string, unknown> = {
  AllowMultiple: {
    type: "BOOLEAN",
    description:
      "If true, multiple occurrences of 'targetContent' will be replaced by 'replacementContent' if they are found. Otherwise if multiple occurences are found, an error will be returned.",
  },
  TargetContent: {
    type: "STRING",
    description:
      "The exact string to be replaced. This must be the exact character-sequence to be replaced, including whitespace. Be very careful to include any leading whitespace otherwise this will not work at all. This must be a unique substring within the file, or else it will error.",
  },
  ReplacementContent: {
    type: "STRING",
    description: "The content to replace the target content with.",
  },
  StartLine: {
    type: "INTEGER",
    description:
      "The starting line number of the chunk (1-indexed). Should be at or before the first line containing the target content. Must satisfy 1 <= StartLine <= EndLine. The target content is searched for within the [StartLine, EndLine] range.",
  },
  EndLine: {
    type: "INTEGER",
    description:
      "The ending line number of the chunk (1-indexed). Should be at or after the last line containing the target content. Must satisfy StartLine <= EndLine <= number of lines in the file. The target content is searched for within the [StartLine, EndLine] range.",
  },
}

const OFFICIAL_ANTIGRAVITY_TOOL_DECLARATIONS: OfficialAntigravityToolDeclarationDefinition[] =
  [
    {
      name: "command_status",
      description:
        "Get the status of a previously executed terminal command by its ID. Returns the current status (running, done), output lines as specified by output priority, and any error if present. Do not try to check the status of any IDs other than Background command IDs.",
      properties: {
        CommandId: {
          type: "STRING",
          description: "ID of the command to get status for",
        },
        OutputCharacterCount: {
          type: "INTEGER",
          description:
            "Number of characters to view. Make this as small as possible to avoid excessive memory usage.",
        },
        WaitDurationSeconds: {
          type: "INTEGER",
          description:
            "Number of seconds to wait for command completion before getting the status. If the command completes before this duration, this tool call will return early. Set to 0 to get the status of the command immediately. If you are only interested in waiting for command completion, set to the max value, 300.",
        },
      },
      required: ["CommandId", "WaitDurationSeconds"],
      isEnabled: (context) => context.hasCommandStatusCapability,
    },
    {
      name: "generate_image",
      description:
        "Generate an image or edit existing images based on a text prompt. The resulting image will be saved as an artifact for use. You can use this tool to generate user interfaces and iterate on a design with the USER for an application or website that you are building. When creating UI designs, generate only the interface itself without surrounding device frames (laptops, phones, tablets, etc.) unless the user explicitly requests them. You can also use this tool to generate assets for use in an application or website.",
      properties: {
        ImageName: {
          type: "STRING",
          description:
            "Name of the generated image to save. Should be all lowercase with underscores, describing what the image contains. Maximum 3 words. Example: 'login_page_mockup'",
        },
        ImagePaths: {
          type: "ARRAY",
          description:
            "Optional absolute paths to the images to use in generation. You can pass in images here if you would like to edit or combine images. You can pass in artifact images and any images in the file system. Note: you cannot pass in more than 3 images.",
          items: { type: "STRING" },
        },
        Prompt: {
          type: "STRING",
          description: "The text prompt to generate an image for.",
        },
      },
      required: ["Prompt", "ImageName"],
      isEnabled: (context) =>
        context.hasGenerateImageCapability &&
        context.available.has("generate_image"),
    },
    {
      name: "grep_search",
      description:
        "Use ripgrep to find exact pattern matches within files or directories.\nALWAYS use this tool for repository text/code search instead of run_command with grep, rg, find, or similar shell search commands, unless the USER explicitly requests shell command execution.\nResults are returned in JSON format and for each match you will receive the:\n- Filename\n- LineNumber\n- LineContent: the content of the matching line\nTotal results are capped at 50 matches. Use the Includes option to filter by file type or specific paths to refine your search.",
      properties: {
        CaseInsensitive: {
          type: "BOOLEAN",
          description: "If true, performs a case-insensitive search.",
        },
        Includes: {
          type: "ARRAY",
          description:
            "Glob patterns to filter files found within the 'SearchPath', if 'SearchPath' is a directory. For example, '*.go' to only include Go files, or '!**/vendor/*' to exclude vendor directories. This is NOT for specifying the primary search directory; use 'SearchPath' for that. Leave empty if no glob filtering is needed or if 'SearchPath' is a single file.",
          items: { type: "STRING" },
        },
        IsRegex: {
          type: "BOOLEAN",
          description:
            "If true, treats Query as a regular expression pattern with special characters like *, +, (, etc. having regex meaning. If false, treats Query as a literal string where all characters are matched exactly. Use false for normal text searches and true only when you specifically need regex functionality.",
        },
        MatchPerLine: {
          type: "BOOLEAN",
          description:
            "If true, returns each line that matches the query, including line numbers and snippets of matching lines (equivalent to 'git grep -nI'). If false, only returns the names of files containing the query (equivalent to 'git grep -l').",
        },
        Query: {
          type: "STRING",
          description: "The search term or pattern to look for within files.",
        },
        SearchPath: {
          type: "STRING",
          description:
            "The path to search. This can be a directory or a file. This is a required parameter.",
        },
      },
      required: ["SearchPath", "Query"],
      isEnabled: (context) => context.available.has("grep_search"),
    },
    {
      name: "list_dir",
      description:
        "List the contents of a directory, i.e. all files and subdirectories that are children of the directory. Prefer this tool over run_command with ls, find, or similar shell commands when you need workspace file/directory discovery. Directory path must be an absolute path to a directory that exists. For each child in the directory, output will have: relative path to the directory, whether it is a directory or file, size in bytes if file, and number of children (recursive) if directory. Number of children may be missing if the workspace is too large, since we are not able to track the entire workspace.",
      properties: {
        DirectoryPath: {
          type: "STRING",
          description:
            "Path to list contents of, should be absolute path to a directory",
        },
      },
      required: ["DirectoryPath"],
      isEnabled: (context) => context.available.has("list_dir"),
    },
    {
      name: "multi_replace_file_content",
      description:
        "Use this tool to edit an existing file. Follow these rules:\n1. Before editing, you MUST first call view_file for this file in the current conversation.\n2. Use this tool ONLY when you are making MULTIPLE, NON-CONTIGUOUS edits to the same file (i.e., you are changing more than one separate block of text). If you are making a single contiguous block of edits, use the replace_file_content tool instead.\n3. Do NOT use this tool if you are only editing a single contiguous block of lines.\n4. Do NOT make multiple parallel calls to this tool or the replace_file_content tool for the same file.\n5. To edit multiple, non-adjacent lines of code in the same file, make a single call to this tool. Specify each edit as a separate ReplacementChunk.\n6. For each ReplacementChunk, specify StartLine, EndLine, TargetContent and ReplacementContent. StartLine and EndLine should specify a range of lines containing precisely the instances of TargetContent that you wish to edit. To edit a single instance of the TargetContent, the range should be such that it contains that specific instance of the TargetContent and no other instances. When applicable, provide a range that matches the range viewed in a previous view_file call.\n7. In TargetContent, copy the current file text verbatim. If you are copying from view_file output, NEVER include the line number prefixes; only copy the actual file text after the prefix separator.\n8. Prefer the SMALLEST unique TargetContent that clearly identifies the edit, usually 2-4 adjacent lines. Do not include large blocks of surrounding context when a shorter unique excerpt is sufficient.\n9. In ReplacementContent, specify the replacement content for the specified target content. This must be a complete drop-in replacement of the TargetContent, with necessary modifications made.\n10. If you are making multiple edits across a single file, specify multiple separate ReplacementChunks. DO NOT try to replace the entire existing content with the new content, this is very expensive.\n11. You may not edit file extensions: [.ipynb]\nIMPORTANT: You must generate the following arguments first, before any others: [TargetFile]",
      properties: {
        TargetFile: {
          type: "STRING",
          description:
            "The target file to modify. Always specify the target file as the very first argument.",
        },
        Instruction: {
          type: "STRING",
          description:
            "A description of the changes that you are making to the file.",
        },
        Description: {
          type: "STRING",
          description:
            "Brief, user-facing explanation of what this change did. Focus on non-obvious rationale, design decisions, or important context. Don't just restate what the code does.",
        },
        ArtifactMetadata: {
          type: "OBJECT",
          description:
            "Metadata updates if updating an artifact file, leave blank if not updating an artifact. Should be updated if the content is changing meaningfully.",
          properties: ARTIFACT_METADATA_PROPERTIES,
          required: ARTIFACT_METADATA_REQUIRED,
        },
        ReplacementChunks: {
          type: "ARRAY",
          description:
            "A list of chunks to replace. It is best to provide multiple chunks for non-contiguous edits if possible. This must be a JSON array, not a string.",
          items: {
            type: "OBJECT",
            properties: REPLACEMENT_CHUNK_PROPERTIES,
            required: [
              "AllowMultiple",
              "TargetContent",
              "ReplacementContent",
              "StartLine",
              "EndLine",
            ],
          },
        },
      },
      required: [
        "TargetFile",
        "Instruction",
        "Description",
        "ReplacementChunks",
      ],
      isEnabled: (context) => context.hasEditCapability,
    },
    {
      name: "read_url_content",
      description:
        "Fetch content from a URL via HTTP request (invisible to USER). Use when: (1) extracting text from public pages, (2) reading static content/documentation, (3) batch processing multiple URLs, (4) speed is important, or (5) no visual interaction needed. Converts HTML to markdown. No JavaScript execution, no authentication. For pages requiring login, JavaScript, or USER visibility, use read_browser_page instead.",
      properties: {
        Url: {
          type: "STRING",
          description: "URL to read content from",
        },
      },
      required: ["Url"],
      isEnabled: (context) => context.available.has("read_url_content"),
    },
    {
      name: "replace_file_content",
      description:
        "Use this tool to edit an existing file. Follow these rules:\n1. Before editing, you MUST first call view_file for this file in the current conversation.\n2. Use this tool ONLY when you are making a SINGLE CONTIGUOUS block of edits to the same file (i.e. replacing a single contiguous block of text). If you are making edits to multiple non-adjacent lines, use the multi_replace_file_content tool instead.\n3. Do NOT make multiple parallel calls to this tool or the multi_replace_file_content tool for the same file.\n4. To edit multiple, non-adjacent lines of code in the same file, make a single call to the multi_replace_file_content tool.\n5. For the ReplacementChunk, specify StartLine, EndLine, TargetContent and ReplacementContent. StartLine and EndLine should specify a range of lines containing precisely the instances of TargetContent that you wish to edit. To edit a single instance of the TargetContent, the range should be such that it contains that specific instance of the TargetContent and no other instances. When applicable, provide a range that matches the range viewed in a previous view_file call.\n6. In TargetContent, copy the current file text verbatim. If you are copying from view_file output, NEVER include the line number prefixes; only copy the actual file text after the prefix separator.\n7. Prefer the SMALLEST unique TargetContent that clearly identifies the edit, usually 2-4 adjacent lines. Do not include large blocks of surrounding context when a shorter unique excerpt is sufficient.\n8. In ReplacementContent, specify the replacement content for the specified target content. This must be a complete drop-in replacement of the TargetContent, with necessary modifications made.\n9. If you are making multiple edits across a single file, use the multi_replace_file_content tool instead. DO NOT try to replace the entire existing content with the new content, this is very expensive.\n10. You may not edit file extensions: [.ipynb]\nIMPORTANT: You must generate the following arguments first, before any others: [TargetFile]",
      properties: {
        TargetFile: {
          type: "STRING",
          description:
            "The target file to modify. Always specify the target file as the very first argument.",
        },
        Instruction: {
          type: "STRING",
          description:
            "A description of the changes that you are making to the file.",
        },
        Description: {
          type: "STRING",
          description:
            "Brief, user-facing explanation of what this change did. Focus on non-obvious rationale, design decisions, or important context. Don't just restate what the code does.",
        },
        AllowMultiple: {
          type: "BOOLEAN",
          description:
            "If true, multiple occurrences of 'targetContent' will be replaced by 'replacementContent' if they are found. Otherwise if multiple occurences are found, an error will be returned.",
        },
        TargetContent: {
          type: "STRING",
          description:
            "The exact string to be replaced. This must be the exact character-sequence to be replaced, including whitespace. Be very careful to include any leading whitespace otherwise this will not work at all. This must be a unique substring within the file, or else it will error. If you copied text from view_file output, remove the line number prefixes and copy only the actual file text.",
        },
        ReplacementContent: {
          type: "STRING",
          description:
            "The content to replace the target content with. Do not include line number prefixes from view_file output.",
        },
        StartLine: {
          type: "INTEGER",
          description:
            "The starting line number of the chunk (1-indexed). Should be at or before the first line containing the target content. Must satisfy 1 <= StartLine <= EndLine. The target content is searched for within the [StartLine, EndLine] range. Prefer a range copied from a recent view_file result and keep it tight enough that the target is unique.",
        },
        EndLine: {
          type: "INTEGER",
          description:
            "The ending line number of the chunk (1-indexed). Should be at or after the last line containing the target content. Must satisfy StartLine <= EndLine <= number of lines in the file. The target content is searched for within the [StartLine, EndLine] range. Prefer a range copied from a recent view_file result and keep it tight enough that the target is unique.",
        },
        TargetLintErrorIds: {
          type: "ARRAY",
          description:
            "If applicable, IDs of lint errors this edit aims to fix (they'll have been given in recent IDE feedback). If you believe the edit could fix lints, do specify lint IDs; if the edit is wholly unrelated, do not. A rule of thumb is, if your edit was influenced by lint feedback, include lint IDs. Exercise honest judgement here.",
          items: { type: "STRING" },
        },
      },
      required: [
        "TargetFile",
        "Instruction",
        "Description",
        "AllowMultiple",
        "TargetContent",
        "ReplacementContent",
        "StartLine",
        "EndLine",
      ],
      isEnabled: (context) => context.hasEditCapability,
    },
    {
      name: "run_command",
      description:
        "PROPOSE a command to run on behalf of the user. Operating System: mac. Shell: zsh.\n**NEVER PROPOSE A cd COMMAND**.\nIf you have this tool, note that you DO have the ability to run commands directly on the USER's system.\nDo NOT use this tool for ordinary repository search, file reading, or deterministic file edits when grep_search, view_file, list_dir, replace_file_content, multi_replace_file_content, or write_to_file can express the task. In particular, avoid grep, rg, find, sed, cat, head, and tail for normal code inspection when structured tools are available.\nMake sure to specify CommandLine exactly as it should be run in the shell.\nNote that the user will have to approve the command before it is executed. The user may reject it if it is not to their liking.\nThe actual command will NOT execute until the user approves it. The user may not approve it immediately.\nIf the step is WAITING for user approval, it has NOT started running.\nIf the step returns a command id, it means that the command was sent to the background. You should use the command_status tool to monitor the output and status of the command.\nCommands will be run with PAGER=cat. You may want to limit the length of output for commands that usually rely on paging and may contain very long output (e.g. git log, use git log -n <N>).\nIMPORTANT: The Cwd (working directory) MUST be within the user's workspace. Do NOT use /tmp, /home, or any path outside the workspace. If you need a temporary directory, create one inside the workspace.",
      properties: {
        Cwd: {
          type: "STRING",
          description: "The current working directory for the command",
        },
        WaitMsBeforeAsync: {
          type: "INTEGER",
          description:
            "This specifies the number of milliseconds to wait after starting the command before sending it to the background. If you want the command to complete execution synchronously, set this to a large enough value that you expect the command to complete in that time under ordinary circumstances. If you're starting an interactive or long-running command, set it to a large enough value that it would cause possible failure cases to execute synchronously (e.g. 500ms). Keep the value as small as possible, with a maximum of 10000ms.",
        },
        SafeToAutoRun: {
          type: "BOOLEAN",
          description:
            "Set to true if you believe that this command is safe to run WITHOUT user approval. A command is unsafe if it may have some destructive side-effects. Example unsafe side-effects include: deleting files, mutating state, installing system dependencies, making external requests, etc. Set to true only if you are extremely confident it is safe. If you feel the command could be unsafe, never set this to true, EVEN if the USER asks you to. It is imperative that you never auto-run a potentially unsafe command.",
        },
        CommandLine: {
          type: "STRING",
          description: "The exact command line string to execute.",
        },
        RunPersistent: {
          type: "BOOLEAN",
          description:
            "Set to true to run this command in a persistent terminal that preserves environment and shell variables between invocations. Returns a TerminalID that can be specified in future run_command calls to share the environment. Note: persistent terminals share variables but are separate bash -c invocations; shell state like working directory, aliases, and functions are not shared.",
        },
        RequestedTerminalID: {
          type: "STRING",
          description:
            "Optional ID of a persistent terminal to reuse. Specify a TerminalID returned from a previous persistent run_command to share its variables. Can only be used when RunPersistent is true. Leave this empty with RunPersistent set to true to create a new persistent terminal.",
        },
      },
      required: ["Cwd", "WaitMsBeforeAsync", "SafeToAutoRun", "CommandLine"],
      isEnabled: (context) => context.hasRunCommandCapability,
    },
    {
      name: "search_web",
      description:
        "Performs a web search for a given query. Returns a summary of relevant information along with URL citations.",
      properties: {
        domain: {
          type: "STRING",
          description: "Optional domain to recommend the search prioritize",
        },
        query: { type: "STRING" },
      },
      required: ["query"],
      isEnabled: (context) => context.available.has("search_web"),
    },
    {
      name: "send_command_input",
      description:
        "Send standard input to a running command or to terminate a command. Use this to interact with REPLs, interactive commands, and long-running processes. The command must have been created by a previous run_command call. Use the command_status tool to check the status and output of the command after sending input.",
      properties: {
        CommandId: {
          type: "STRING",
          description:
            "The command ID from a previous run_command call. This is returned in the run_command output.",
        },
        Input: {
          type: "STRING",
          description:
            "The input to send to the command's stdin. Include newline characters (the literal character, not the escape sequence) if needed to submit commands. Exactly one of input and terminate must be specified.",
        },
        Terminate: {
          type: "BOOLEAN",
          description:
            "Whether to terminate the command. Exactly one of input and terminate must be specified.",
        },
        WaitMs: {
          type: "INTEGER",
          description:
            "Amount of time to wait for output after sending input. Keep the value as small as possible, but large enough to capture the output you expect. Must be between 500ms and 10000ms.",
        },
        SafeToAutoRun: {
          type: "BOOLEAN",
          description:
            "Set to true if you believe that this command is safe to run WITHOUT user approval. An input is unsafe if it may have some destructive side-effects. Example unsafe side-effects include: deleting files, mutating state, installing system dependencies, making external requests, etc. Set to true only if you are extremely confident it is safe. If you feel the input could be unsafe, never set this to true, EVEN if the USER asks you to. It is imperative that you never auto-run a potentially unsafe input.",
        },
      },
      required: ["CommandId", "WaitMs", "SafeToAutoRun"],
      isEnabled: (context) => context.hasSendCommandInputCapability,
    },
    {
      name: "view_file",
      description:
        "View the contents of a file from the local filesystem. Prefer this tool over run_command with cat, sed, head, tail, or similar shell commands for file inspection. This tool supports some binary files such as images and videos.\nText file usage:\n- The lines of the file are 1-indexed\n- The first time you read a new file the tool will enforce reading 800 lines to understand as much about the file as possible\n- The output of this tool call will be the file contents from StartLine to EndLine (inclusive)\n- Output may include line numbers for display. When using view_file output as the source for a later edit, copy ONLY the actual file text and NEVER include the line number prefixes.\n- You can view at most 800 lines at a time\n- To view the whole file do not pass StartLine or EndLine arguments\nBinary file usage:\n- Do not provide StartLine or EndLine arguments, this tool always returns the entire file",
      properties: {
        AbsolutePath: {
          type: "STRING",
          description: "Path to file to view. Must be an absolute path.",
        },
        EndLine: {
          type: "INTEGER",
          description:
            "Optional. Endline to view, 1-indexed as usual, inclusive. This value must be greater than or equal to StartLine.",
        },
        IsSkillFile: {
          type: "BOOLEAN",
          description:
            "Optional. Set to true only when reading a file to execute its instructions for a task. Set to false if the purpose is to edit, preview, or manage the file.",
        },
        StartLine: {
          type: "INTEGER",
          description:
            "Optional. Startline to view, 1-indexed as usual, inclusive. This value must be less than or equal to EndLine.",
        },
      },
      required: ["AbsolutePath"],
      isEnabled: (context) => context.available.has("view_file"),
    },
    {
      name: "write_to_file",
      description:
        "Use this tool to create new files. Prefer this tool over run_command with cat heredocs, echo redirection, or other shell-based file creation. The file and any parent directories will be created for you if they do not already exist.\n\t\tFollow these instructions:\n\t\t1. By default this tool will error if TargetFile already exists. To overwrite an existing file, set Overwrite to true.\n\t\t2. You MUST specify TargetFile as the FIRST argument. Please specify the full TargetFile before any of the code contents.\n\t\t3. When creating an artifact, make sure to set IsArtifact to true and provide an ArtifactMetadata.\nIMPORTANT: You must generate the following arguments first, before any others: [TargetFile, Overwrite]",
      properties: {
        TargetFile: {
          type: "STRING",
          description: "The target file to create and write code to.",
        },
        Overwrite: {
          type: "BOOLEAN",
          description:
            "Set this to true to overwrite an existing file. WARNING: This will replace the entire file contents. Only use when you explicitly intend to overwrite. Otherwise, use a code edit tool to modify existing files.",
        },
        CodeContent: {
          type: "STRING",
          description: "The code contents to write to the file.",
        },
        Description: {
          type: "STRING",
          description:
            "Brief, user-facing explanation of what this change did. Focus on non-obvious rationale, design decisions, or important context. Don't just restate what the code does.",
        },
        IsArtifact: {
          type: "BOOLEAN",
          description: "Set this to true when creating an artifact file.",
        },
        ArtifactMetadata: {
          type: "OBJECT",
          description:
            "Metadata for the artifact, required when IsArtifact is true.",
          properties: ARTIFACT_METADATA_PROPERTIES,
          required: ARTIFACT_METADATA_REQUIRED,
        },
      },
      required: [
        "TargetFile",
        "Overwrite",
        "CodeContent",
        "Description",
        "IsArtifact",
      ],
      isEnabled: (context) => context.hasEditCapability,
    },
  ]

export function normalizeOfficialAntigravityToolToken(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

export function toOfficialAntigravityToolName(name: string): string {
  const normalized = normalizeOfficialAntigravityToolToken(name)
  const map: Record<string, string> = {
    read_file: "view_file",
    read_file_v2: "view_file",
    view_file: "view_file",
    list_directory: "list_dir",
    list_dir: "list_dir",
    grep_search: "grep_search",
    ripgrep_search: "grep_search",
    edit_file: "replace_file_content",
    edit_file_v2: "replace_file_content",
    replace_file_content: "replace_file_content",
    multi_replace_file_content: "multi_replace_file_content",
    write_to_file: "write_to_file",
    run_terminal_command: "run_command",
    run_terminal_command_v2: "run_command",
    shell: "run_command",
    run_command: "run_command",
    background_shell_spawn: "run_command",
    write_shell_stdin: "send_command_input",
    send_command_input: "send_command_input",
    command_status: "command_status",
    web_search: "search_web",
    search_web: "search_web",
    web_fetch: "read_url_content",
    read_url_content: "read_url_content",
    generate_image: "generate_image",
    browser_subagent: "browser_subagent",
  }
  return map[normalized] || normalized
}

export function fromOfficialAntigravityToolName(name: string): string {
  const normalized = normalizeOfficialAntigravityToolToken(name)
  const map: Record<string, string> = {
    view_file: "view_file",
    list_dir: "list_dir",
    run_command: "run_command",
    send_command_input: "send_command_input",
    replace_file_content: "replace_file_content",
    multi_replace_file_content: "multi_replace_file_content",
    write_to_file: "write_to_file",
    search_web: "search_web",
    read_url_content: "read_url_content",
    command_status: "command_status",
    generate_image: "generate_image",
    browser_subagent: "browser_subagent",
  }
  return map[normalized] || name
}

export function adaptOfficialAntigravityToolInput(
  officialName: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  const normalized = normalizeOfficialAntigravityToolToken(officialName)
  switch (normalized) {
    case "browser_subagent":
      return {
        description:
          input.Task || input.task || input.description || input.TaskSummary,
        prompt: input.Task || input.task || input.description,
        subagent_type: "browser",
      }
    default:
      return { ...input }
  }
}

function buildDeclarationParameters(
  properties: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  return {
    type: "OBJECT",
    properties: {
      ...properties,
      toolAction: {
        type: "STRING",
        description: TOOL_ACTION_DESCRIPTION,
      },
      toolSummary: {
        type: "STRING",
        description: TOOL_SUMMARY_DESCRIPTION,
      },
      waitForPreviousTools: {
        type: "BOOLEAN",
        description: WAIT_FOR_PREVIOUS_TOOLS_DESCRIPTION,
      },
    },
    ...(required.length > 0 ? { required } : {}),
  }
}

function buildOfficialAntigravityToolCapabilityContext(
  tools: ToolDefinitionLike[]
): OfficialAntigravityToolCapabilityContext {
  const available = new Set<string>()
  for (const tool of tools) {
    if (typeof tool?.name !== "string") continue
    available.add(toOfficialAntigravityToolName(tool.name))
  }

  const hasEditCapability =
    available.has("replace_file_content") ||
    available.has("multi_replace_file_content") ||
    available.has("write_to_file")
  const hasRunCommandCapability = available.has("run_command")
  const hasSendCommandInputCapability = available.has("send_command_input")
  const hasCommandStatusCapability =
    available.has("command_status") || hasRunCommandCapability
  const hasGenerateImageCapability = available.has("generate_image")

  return {
    available,
    hasEditCapability,
    hasRunCommandCapability,
    hasSendCommandInputCapability,
    hasCommandStatusCapability,
    hasGenerateImageCapability,
  }
}

export function buildOfficialAntigravityToolDeclarations(
  tools: ToolDefinitionLike[]
): CloudCodeToolDeclaration[] {
  const context = buildOfficialAntigravityToolCapabilityContext(tools)

  return OFFICIAL_ANTIGRAVITY_TOOL_DECLARATIONS.filter((tool) =>
    tool.isEnabled(context)
  ).map((tool) => ({
    functionDeclarations: [
      {
        name: tool.name,
        description: tool.description,
        parameters: buildDeclarationParameters(tool.properties, tool.required),
      },
    ],
  }))
}

function pickFirstString(
  source: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const raw = source[key]
    if (typeof raw === "string" && raw.trim() !== "") {
      return raw.trim()
    }
  }
  return undefined
}

function pickFirstRawString(
  source: Record<string, unknown>,
  keys: string[],
  options?: { allowEmpty?: boolean }
): string | undefined {
  const allowEmpty = options?.allowEmpty ?? false
  for (const key of keys) {
    const raw = source[key]
    if (typeof raw !== "string") continue
    if (allowEmpty || raw.length > 0) {
      return raw
    }
  }
  return undefined
}

function pickFirstRawStringFromSources(
  sources: Array<Record<string, unknown> | undefined>,
  keys: string[],
  options?: { allowEmpty?: boolean }
): string | undefined {
  for (const source of sources) {
    if (!source) continue
    const value = pickFirstRawString(source, keys, options)
    if (value !== undefined) {
      return value
    }
  }
  return undefined
}

function pickFirstNumber(
  source: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const raw = source[key]
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return Math.floor(raw)
    }
    if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Number.parseInt(raw, 10)
      if (Number.isFinite(parsed)) {
        return Math.floor(parsed)
      }
    }
  }
  return undefined
}

function pickFirstNumberFromSources(
  sources: Array<Record<string, unknown> | undefined>,
  keys: string[]
): number | undefined {
  for (const source of sources) {
    if (!source) continue
    const value = pickFirstNumber(source, keys)
    if (value !== undefined) {
      return value
    }
  }
  return undefined
}

function pickFirstBoolean(
  source: Record<string, unknown>,
  keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const raw = source[key]
    if (typeof raw === "boolean") return raw
    if (typeof raw === "string") {
      const normalized = raw.trim().toLowerCase()
      if (normalized === "true") return true
      if (normalized === "false") return false
    }
  }
  return undefined
}

function pickFirstBooleanFromSources(
  sources: Array<Record<string, unknown> | undefined>,
  keys: string[]
): boolean | undefined {
  for (const source of sources) {
    if (!source) continue
    const value = pickFirstBoolean(source, keys)
    if (value !== undefined) {
      return value
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function pickFirstObject(
  source: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const raw = source[key]
    if (isRecord(raw)) {
      return raw
    }
  }
  return undefined
}

function pickRecordArray(
  source: Record<string, unknown>,
  keys: string[]
): Record<string, unknown>[] {
  for (const key of keys) {
    const raw = source[key]
    if (!Array.isArray(raw)) continue
    const records = raw.filter(isRecord)
    if (records.length > 0) {
      return records
    }
  }
  return []
}

function pickStringArray(
  source: Record<string, unknown>,
  keys: string[]
): string[] {
  for (const key of keys) {
    const raw = source[key]
    if (Array.isArray(raw)) {
      const values = raw
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0)
      if (values.length > 0) {
        return values
      }
    }
    if (typeof raw === "string" && raw.trim() !== "") {
      return [raw.trim()]
    }
  }
  return []
}

export function normalizeOfficialAntigravityArtifactType(
  value: string
): OfficialAntigravityArtifactType | undefined {
  const normalized = normalizeOfficialAntigravityToolToken(value)
  if (
    normalized === "implementation_plan" ||
    normalized === "walkthrough" ||
    normalized === "task" ||
    normalized === "other"
  ) {
    return normalized
  }
  return undefined
}

export function extractOfficialAntigravityArtifactMetadata(
  input: Record<string, unknown>
): OfficialAntigravityArtifactMetadata | undefined {
  const raw =
    (input.ArtifactMetadata as Record<string, unknown> | undefined) ||
    (input.artifactMetadata as Record<string, unknown> | undefined) ||
    (input.artifact_metadata as Record<string, unknown> | undefined)
  if (!raw || typeof raw !== "object") return undefined

  const artifactTypeValue = pickFirstString(raw, [
    "ArtifactType",
    "artifactType",
    "artifact_type",
  ])
  const artifactType = artifactTypeValue
    ? normalizeOfficialAntigravityArtifactType(artifactTypeValue)
    : undefined
  if (!artifactType) return undefined

  const summary = pickFirstString(raw, ["Summary", "summary"]) || ""
  const requestFeedback = pickFirstBoolean(raw, [
    "RequestFeedback",
    "requestFeedback",
    "request_feedback",
  ])

  return {
    artifactType,
    ...(summary ? { summary } : {}),
    ...(typeof requestFeedback === "boolean" ? { requestFeedback } : {}),
  }
}

export function pickOfficialAntigravityFilePath(
  input: Record<string, unknown>
): string {
  return (
    pickFirstString(input, [
      "SearchPath",
      "searchPath",
      "search_path",
      "TargetFile",
      "targetFile",
      "target_file",
      "AbsolutePath",
      "absolutePath",
      "absolute_path",
      "DirectoryPath",
      "directoryPath",
      "directory_path",
      "path",
      "filePath",
      "file_path",
    ]) || ""
  )
}

function buildCanonicalOfficialAntigravityEditMetadata(
  input: Record<string, unknown>,
  pathValue: string
): Record<string, unknown> {
  const metadata = extractOfficialAntigravityArtifactMetadata(input)
  const description =
    pickFirstString(input, ["Description", "description"]) || ""
  const instruction =
    pickFirstString(input, ["Instruction", "instruction"]) || ""
  const overwrite = pickFirstBoolean(input, ["Overwrite", "overwrite"])
  const isArtifact = pickFirstBoolean(input, [
    "IsArtifact",
    "isArtifact",
    "is_artifact",
  ])

  return {
    path: pathValue,
    ...(description ? { description } : {}),
    ...(instruction ? { instruction } : {}),
    ...(typeof overwrite === "boolean"
      ? { overwrite, Overwrite: overwrite }
      : {}),
    ...(typeof isArtifact === "boolean"
      ? { isArtifact, is_artifact: isArtifact, IsArtifact: isArtifact }
      : {}),
    ...(metadata
      ? {
          artifactMetadata: metadata,
          artifact_metadata: metadata,
          ArtifactMetadata: {
            ArtifactType: metadata.artifactType,
            ...(typeof metadata.requestFeedback === "boolean"
              ? { RequestFeedback: metadata.requestFeedback }
              : {}),
            ...(metadata.summary ? { Summary: metadata.summary } : {}),
          },
        }
      : {}),
  }
}

function hasOwnEditChunkField(source: Record<string, unknown>): boolean {
  return [
    "AllowMultiple",
    "allowMultiple",
    "allow_multiple",
    "TargetContent",
    "targetContent",
    "target_content",
    "search",
    "target",
    "old_text",
    "oldText",
    "ReplacementContent",
    "replacementContent",
    "replacement_content",
    "replace",
    "replacement",
    "new_text",
    "newText",
    "StartLine",
    "startLine",
    "start_line",
    "EndLine",
    "endLine",
    "end_line",
  ].some((key) => Object.prototype.hasOwnProperty.call(source, key))
}

function normalizeOfficialEditChunkFromSources(
  sources: Array<Record<string, unknown> | undefined>
): OfficialAntigravityNormalizedEditChunk {
  return {
    allowMultiple: pickFirstBooleanFromSources(sources, [
      "AllowMultiple",
      "allowMultiple",
      "allow_multiple",
    ]),
    targetContent: pickFirstRawStringFromSources(
      sources,
      [
        "TargetContent",
        "targetContent",
        "target_content",
        "search",
        "target",
        "old_text",
        "oldText",
      ],
      { allowEmpty: true }
    ),
    replacementContent: pickFirstRawStringFromSources(
      sources,
      [
        "ReplacementContent",
        "replacementContent",
        "replacement_content",
        "replace",
        "replacement",
        "new_text",
        "newText",
      ],
      { allowEmpty: true }
    ),
    startLine: pickFirstNumberFromSources(sources, [
      "StartLine",
      "startLine",
      "start_line",
    ]),
    endLine: pickFirstNumberFromSources(sources, [
      "EndLine",
      "endLine",
      "end_line",
    ]),
  }
}

function buildCanonicalReplacementChunk(
  chunk: OfficialAntigravityNormalizedEditChunk
): Record<string, unknown> {
  return {
    ...(typeof chunk.allowMultiple === "boolean"
      ? { allowMultiple: chunk.allowMultiple }
      : {}),
    ...(chunk.targetContent !== undefined
      ? { targetContent: chunk.targetContent }
      : {}),
    ...(chunk.replacementContent !== undefined
      ? { replacementContent: chunk.replacementContent }
      : {}),
    ...(typeof chunk.startLine === "number"
      ? { startLine: chunk.startLine }
      : {}),
    ...(typeof chunk.endLine === "number" ? { endLine: chunk.endLine } : {}),
  }
}

function buildOfficialEditValidationError(
  toolName: string,
  issues: string[]
): string {
  return `${toolName} invalid input: ${issues.join("; ")}`
}

function validateOfficialEditChunk(
  chunk: OfficialAntigravityNormalizedEditChunk,
  options?: { index?: number }
): string[] {
  const issues: string[] = []
  const prefix =
    typeof options?.index === "number"
      ? `ReplacementChunks[${options.index}]`
      : ""

  if (chunk.targetContent === undefined) {
    issues.push(`${prefix || "TargetContent"} is required`)
  } else if (chunk.targetContent.length === 0) {
    issues.push(
      `${prefix ? `${prefix}.TargetContent` : "TargetContent"} must be non-empty`
    )
  }

  if (chunk.replacementContent === undefined) {
    issues.push(
      `${prefix ? `${prefix}.ReplacementContent` : "ReplacementContent"} is required`
    )
  }

  if (chunk.startLine != null && chunk.startLine < 1) {
    issues.push(`${prefix ? `${prefix}.StartLine` : "StartLine"} must be >= 1`)
  }
  if (chunk.endLine != null && chunk.endLine < 1) {
    issues.push(`${prefix ? `${prefix}.EndLine` : "EndLine"} must be >= 1`)
  }
  if (
    chunk.startLine != null &&
    chunk.endLine != null &&
    chunk.endLine < chunk.startLine
  ) {
    issues.push(
      `${prefix ? `${prefix}.EndLine` : "EndLine"} must be >= ${prefix ? `${prefix}.StartLine` : "StartLine"}`
    )
  }

  return issues
}

function pickOfficialTargetLintErrorIds(
  input: Record<string, unknown>
): string[] | undefined {
  const ids = pickStringArray(input, [
    "TargetLintErrorIds",
    "targetLintErrorIds",
    "target_lint_error_ids",
  ])
  return ids.length > 0 ? ids : undefined
}

function buildCanonicalOfficialSingleEditInvocation(
  toolName: string,
  input: Record<string, unknown>,
  historyToolName: string,
  historyToolInput: Record<string, unknown>,
  filePath: string
): OfficialAntigravityCanonicalToolInvocation {
  const singleChunk = pickFirstObject(input, [
    "ReplacementChunk",
    "replacementChunk",
    "replacement_chunk",
  ])
  const targetLintErrorIds = pickOfficialTargetLintErrorIds(input)
  const chunkArray = pickRecordArray(input, [
    "ReplacementChunks",
    "replacementChunks",
    "replacement_chunks",
  ])
  const issues: string[] = []
  if (!filePath) {
    issues.push("TargetFile is required")
  }
  if (chunkArray.length > 1) {
    issues.push(
      `received ${chunkArray.length} ReplacementChunks; use multi_replace_file_content for multiple edits`
    )
  }

  const chunk = normalizeOfficialEditChunkFromSources([
    input,
    singleChunk,
    chunkArray[0],
  ])
  issues.push(...validateOfficialEditChunk(chunk))

  return {
    toolName: "edit_file_v2",
    input: {
      ...buildCanonicalOfficialAntigravityEditMetadata(input, filePath),
      replacementChunks: [buildCanonicalReplacementChunk(chunk)],
      ...(targetLintErrorIds
        ? { target_lint_error_ids: targetLintErrorIds }
        : {}),
    },
    historyToolName,
    historyToolInput,
    ...(issues.length > 0
      ? {
          validationErrorMessage: buildOfficialEditValidationError(
            toolName,
            issues
          ),
        }
      : {}),
  }
}

function buildCanonicalOfficialMultiEditInvocation(
  toolName: string,
  input: Record<string, unknown>,
  historyToolName: string,
  historyToolInput: Record<string, unknown>,
  filePath: string
): OfficialAntigravityCanonicalToolInvocation {
  const chunkArray = pickRecordArray(input, [
    "ReplacementChunks",
    "replacementChunks",
    "replacement_chunks",
  ])
  const targetLintErrorIds = pickOfficialTargetLintErrorIds(input)
  const singleChunk = pickFirstObject(input, [
    "ReplacementChunk",
    "replacementChunk",
    "replacement_chunk",
  ])
  const rawChunks =
    chunkArray.length > 0
      ? chunkArray
      : singleChunk
        ? [singleChunk]
        : hasOwnEditChunkField(input)
          ? [input]
          : []

  const issues: string[] = []
  if (!filePath) {
    issues.push("TargetFile is required")
  }
  if (rawChunks.length === 0) {
    issues.push("ReplacementChunks must contain at least one replacement chunk")
  }

  const replacementChunks = rawChunks.map((rawChunk, index) => {
    const chunk = normalizeOfficialEditChunkFromSources([rawChunk])
    issues.push(...validateOfficialEditChunk(chunk, { index }))
    return buildCanonicalReplacementChunk(chunk)
  })

  return {
    toolName: "edit_file_v2",
    input: {
      ...buildCanonicalOfficialAntigravityEditMetadata(input, filePath),
      replacementChunks,
      ...(targetLintErrorIds
        ? { target_lint_error_ids: targetLintErrorIds }
        : {}),
    },
    historyToolName,
    historyToolInput,
    ...(issues.length > 0
      ? {
          validationErrorMessage: buildOfficialEditValidationError(
            toolName,
            issues
          ),
        }
      : {}),
  }
}

function buildCanonicalOfficialWriteToFileInvocation(
  toolName: string,
  input: Record<string, unknown>,
  historyToolName: string,
  historyToolInput: Record<string, unknown>,
  filePath: string
): OfficialAntigravityCanonicalToolInvocation {
  const fileText = pickFirstRawString(
    input,
    ["CodeContent", "content", "file_text", "fileText", "text"],
    { allowEmpty: true }
  )
  const issues: string[] = []
  if (!filePath) {
    issues.push("TargetFile is required")
  }
  if (fileText === undefined) {
    issues.push("CodeContent is required")
  }

  return {
    toolName: "edit_file_v2",
    input: {
      ...buildCanonicalOfficialAntigravityEditMetadata(input, filePath),
      ...(fileText !== undefined ? { file_text: fileText } : {}),
    },
    historyToolName,
    historyToolInput,
    ...(issues.length > 0
      ? {
          validationErrorMessage: buildOfficialEditValidationError(
            toolName,
            issues
          ),
        }
      : {}),
  }
}

export function canonicalizeOfficialAntigravityToolInvocation(
  toolName: string,
  input: Record<string, unknown>
): OfficialAntigravityCanonicalToolInvocation | null {
  const normalized = normalizeOfficialAntigravityToolToken(toolName)
  const historyToolInput = { ...input }
  const historyToolName = toolName
  const filePath = pickOfficialAntigravityFilePath(input)

  switch (normalized) {
    case "grep_search": {
      const query =
        pickFirstString(input, [
          "Query",
          "query",
          "pattern",
          "searchTerm",
          "search_term",
        ]) || ""
      const includes = pickStringArray(input, [
        "Includes",
        "includes",
        "include",
        "glob",
        "globs",
      ])
      const matchPerLine = pickFirstBoolean(input, [
        "MatchPerLine",
        "matchPerLine",
        "match_per_line",
      ])
      return {
        toolName: "grep_search",
        input: {
          path:
            pickFirstString(input, [
              "SearchPath",
              "searchPath",
              "search_path",
              "path",
            ]) || filePath,
          query,
          ...(query ? { Query: query } : {}),
          ...(includes.length > 0 ? { includes: [...includes] } : {}),
          ...(typeof pickFirstBoolean(input, [
            "IsRegex",
            "isRegex",
            "is_regex",
          ]) === "boolean"
            ? {
                isRegex: pickFirstBoolean(input, [
                  "IsRegex",
                  "isRegex",
                  "is_regex",
                ]),
              }
            : {}),
          ...(typeof pickFirstBoolean(input, [
            "CaseInsensitive",
            "caseInsensitive",
            "case_insensitive",
            "-i",
          ]) === "boolean"
            ? {
                caseInsensitive: pickFirstBoolean(input, [
                  "CaseInsensitive",
                  "caseInsensitive",
                  "case_insensitive",
                  "-i",
                ]),
              }
            : {}),
          ...(typeof matchPerLine === "boolean" ? { matchPerLine } : {}),
          output_mode:
            matchPerLine === false ? "files_with_matches" : "content",
          head_limit:
            pickFirstNumber(input, ["HeadLimit", "headLimit", "head_limit"]) ??
            50,
          offset: pickFirstNumber(input, ["Offset", "offset"]),
        },
        historyToolName,
        historyToolInput,
      }
    }
    case "view_file":
      return {
        toolName: "read_file",
        input: {
          path: filePath,
          start_line: pickFirstNumber(input, [
            "StartLine",
            "start_line",
            "startLine",
          ]),
          end_line: pickFirstNumber(input, ["EndLine", "end_line", "endLine"]),
          is_skill_file: pickFirstBoolean(input, [
            "IsSkillFile",
            "is_skill_file",
            "isSkillFile",
          ]),
        },
        historyToolName,
        historyToolInput,
      }
    case "list_dir":
      return {
        toolName: "list_directory",
        input: {
          path: filePath,
          recursive: input.recursive,
        },
        historyToolName,
        historyToolInput,
      }
    case "run_command":
      return {
        toolName: "run_terminal_command",
        input: {
          command: pickFirstString(input, ["CommandLine", "command", "cmd"]),
          cwd: pickFirstString(input, [
            "Cwd",
            "cwd",
            "working_directory",
            "workingDirectory",
          ]),
          safeToAutoRun: pickFirstBoolean(input, [
            "SafeToAutoRun",
            "safeToAutoRun",
            "safe_to_auto_run",
          ]),
          runPersistent: pickFirstBoolean(input, [
            "RunPersistent",
            "runPersistent",
            "run_persistent",
          ]),
          requestedTerminalId: pickFirstString(input, [
            "RequestedTerminalID",
            "requestedTerminalId",
            "requested_terminal_id",
          ]),
          waitMsBeforeAsync: pickFirstNumber(input, [
            "WaitMsBeforeAsync",
            "waitMsBeforeAsync",
            "wait_ms_before_async",
          ]),
        },
        historyToolName,
        historyToolInput,
      }
    case "send_command_input":
      return {
        toolName: "write_shell_stdin",
        input: {
          shellId: pickFirstString(input, [
            "CommandId",
            "shellId",
            "shell_id",
            "command_id",
            "commandId",
          ]),
          data:
            pickFirstRawString(input, ["Input", "data", "input", "text"], {
              allowEmpty: true,
            }) ?? undefined,
          terminate: pickFirstBoolean(input, [
            "Terminate",
            "terminate",
            "shouldTerminate",
          ]),
          wait_ms: pickFirstNumber(input, ["WaitMs", "waitMs", "wait_ms"]),
          safeToAutoRun: pickFirstBoolean(input, [
            "SafeToAutoRun",
            "safeToAutoRun",
            "safe_to_auto_run",
          ]),
        },
        historyToolName,
        historyToolInput,
      }
    case "replace_file_content":
      return buildCanonicalOfficialSingleEditInvocation(
        toolName,
        input,
        historyToolName,
        historyToolInput,
        filePath
      )
    case "multi_replace_file_content":
      return buildCanonicalOfficialMultiEditInvocation(
        toolName,
        input,
        historyToolName,
        historyToolInput,
        filePath
      )
    case "write_to_file":
      return buildCanonicalOfficialWriteToFileInvocation(
        toolName,
        input,
        historyToolName,
        historyToolInput,
        filePath
      )
    case "search_web":
      return {
        toolName: "web_search",
        input: {
          query: pickFirstString(input, [
            "query",
            "search_query",
            "searchQuery",
          ]),
          domain: pickFirstString(input, ["domain"]),
        },
        historyToolName,
        historyToolInput,
      }
    case "read_url_content":
      return {
        toolName: "web_fetch",
        input: {
          url: pickFirstString(input, ["url", "Url", "URL"]),
        },
        historyToolName,
        historyToolInput,
      }
    case "command_status":
      return {
        toolName: "command_status",
        input: {
          commandId: pickFirstString(input, [
            "CommandId",
            "commandId",
            "command_id",
          ]),
          waitDurationSeconds: pickFirstNumber(input, [
            "WaitDurationSeconds",
            "waitDurationSeconds",
            "wait_duration_seconds",
          ]),
          outputCharacterCount: pickFirstNumber(input, [
            "OutputCharacterCount",
            "outputCharacterCount",
            "output_character_count",
          ]),
        },
        historyToolName,
        historyToolInput,
      }
    case "generate_image":
      return {
        toolName: "generate_image",
        input: {
          prompt: pickFirstString(input, ["Prompt", "prompt"]),
          filePath: pickFirstString(input, [
            "ImageName",
            "imageName",
            "image_name",
          ]),
          referenceImagePaths:
            pickStringArray(input, [
              "ImagePaths",
              "imagePaths",
              "image_paths",
            ]) || undefined,
        },
        historyToolName,
        historyToolInput,
      }
    case "browser_subagent":
      return {
        toolName: "task",
        input: {
          description:
            input.Task || input.task || input.description || input.TaskSummary,
          prompt: input.Task || input.task || input.description,
          subagent_type: "browser",
        },
        historyToolName,
        historyToolInput,
      }
    default:
      return null
  }
}
