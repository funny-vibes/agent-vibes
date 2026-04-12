/**
 * Cursor Tool Definition Mapper
 * Maps Cursor's CLIENT_SIDE_TOOL_V2_* tools to Anthropic tool format
 * for sending to backend API, and handles tool call responses
 */

// Tool definition in Anthropic format
export interface AnthropicTool {
  name: string
  description: string
  input_schema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
  }
}

// Mapping of Cursor tool names to Anthropic tool definitions
const CURSOR_TOOL_DEFINITIONS: Record<string, AnthropicTool> = {
  CLIENT_SIDE_TOOL_V2_READ_FILE: {
    name: "read_file",
    description:
      "Read the contents of a file at the specified path. Prefer this tool over run_terminal_command for file inspection. Do not use cat, sed, head, tail, or similar shell commands when read_file can express the request. CRITICAL: This tool ONLY works on files. If the path is a directory, using this tool will cause a crash. Use list_directory for directories.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The path to the file to read (MUST be a file, not a directory)",
        },
      },
      required: ["path"],
    },
  },

  CLIENT_SIDE_TOOL_V2_READ_FILE_V2: {
    name: "read_file",
    description:
      "Read the contents of a file at the specified path. Prefer this tool over run_terminal_command for file inspection. Do not use cat, sed, head, tail, or similar shell commands when read_file can express the request. CRITICAL: This tool ONLY works on files. If the path is a directory, using this tool will cause a crash. Use list_directory for directories.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The path to the file to read (MUST be a file, not a directory)",
        },
        start_line: { type: "number", description: "Start line (1-indexed)" },
        end_line: { type: "number", description: "End line (1-indexed)" },
      },
      required: ["path"],
    },
  },

  CLIENT_SIDE_TOOL_V2_LIST_DIR: {
    name: "list_directory",
    description:
      "List the contents of a directory. Prefer this tool over run_terminal_command with ls, find, or similar shell commands when you need workspace file/directory discovery.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the directory to list",
        },
        recursive: {
          type: "boolean",
          description: "Whether to list recursively",
        },
      },
      required: ["path"],
    },
  },

  CLIENT_SIDE_TOOL_V2_LIST_DIR_V2: {
    name: "list_directory",
    description:
      "List the contents of a directory. Prefer this tool over run_terminal_command with ls, find, or similar shell commands when you need workspace file/directory discovery.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the directory to list",
        },
        recursive: {
          type: "boolean",
          description: "Whether to list recursively",
        },
      },
      required: ["path"],
    },
  },

  CLIENT_SIDE_TOOL_V2_EDIT_FILE: {
    name: "edit_file",
    description:
      "Edit a file by applying changes. Before editing, read the file in the current conversation. Copy the existing text verbatim from read_file output, excluding any display-only line number prefixes. Prefer a small unique old_text snippet instead of large blocks of surrounding context.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The path to the file to edit" },
        old_text: { type: "string", description: "The text to replace" },
        new_text: { type: "string", description: "The replacement text" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },

  CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2: {
    name: "edit_file_v2",
    description:
      "Edit a file with exact search and replace. Before editing, read the file in the current conversation. Prefer a small unique search snippet copied verbatim from read_file output. If read_file output includes display-only line number prefixes, do not include those prefixes in search or replace. Do not use run_terminal_command with sed, perl, python, or shell patching for normal file edits when this tool can express the change.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The path to the file to edit" },
        search: { type: "string", description: "The text to search for" },
        replace: { type: "string", description: "The replacement text" },
      },
      required: ["path", "search", "replace"],
    },
  },

  CLIENT_SIDE_TOOL_V2_FILE_SEARCH: {
    name: "file_search",
    description:
      "Search for files by name pattern. Prefer this tool over run_terminal_command with find or ls for file discovery when the task is to locate files rather than execute shell logic.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query or pattern" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH: {
    name: "glob_search",
    description:
      "Search for files using glob patterns. Prefer this tool over run_terminal_command with find or ls for file discovery when glob matching is sufficient.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The glob pattern to match" },
      },
      required: ["pattern"],
    },
  },

  CLIENT_SIDE_TOOL_V2_RIPGREP_SEARCH: {
    name: "grep_search",
    description:
      "Search file contents using ripgrep. ALWAYS use this tool for repository text/code search instead of run_terminal_command with grep, rg, find, or similar shell search commands, unless the user explicitly asks for shell command execution.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        path: { type: "string", description: "The path to search in" },
        case_sensitive: {
          type: "boolean",
          description: "Case sensitive search",
        },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH: {
    name: "grep_search",
    description:
      "Search file contents using ripgrep. ALWAYS use this tool for repository text/code search instead of run_terminal_command with grep, rg, find, or similar shell search commands, unless the user explicitly asks for shell command execution.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        path: { type: "string", description: "The path to search in" },
        case_sensitive: {
          type: "boolean",
          description: "Case sensitive search",
        },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL: {
    name: "semantic_search",
    description: "Perform semantic code search across the codebase",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The semantic search query" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2: {
    name: "run_terminal_command",
    description:
      "Run a command in the terminal. Do NOT use this for normal repository search, file reading, or deterministic file edits when grep_search, read_file, list_directory, or edit_file_v2 can express the task. In particular, avoid grep, rg, find, sed, cat, head, and tail for ordinary code inspection when structured tools are available. Use this when the user explicitly wants command execution or no structured tool fits.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        cwd: {
          type: "string",
          description: "Working directory for the command",
        },
      },
      required: ["command"],
    },
  },

  CLIENT_SIDE_TOOL_V2_DELETE_FILE: {
    name: "delete_file",
    description: "Delete a file at the specified path",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The path to the file to delete" },
      },
      required: ["path"],
    },
  },

  CLIENT_SIDE_TOOL_V2_WEB_SEARCH: {
    name: "web_search",
    description: "Search the web for information",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_WEB_FETCH: {
    name: "web_fetch",
    description: "Fetch and summarize content from a URL",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },

  CLIENT_SIDE_TOOL_V2_CREATE_PLAN: {
    name: "create_plan",
    description: "Create an implementation plan for a task",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Plan title" },
        steps: {
          type: "array",
          description: "List of steps",
          items: { type: "string" },
        },
      },
      required: ["title", "steps"],
    },
  },

  CLIENT_SIDE_TOOL_V2_TASK: {
    name: "task",
    description: "Delegate a task/sub-agent execution request",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Task description" },
        prompt: { type: "string", description: "Task prompt" },
        model: { type: "string", description: "Optional model override" },
        subagent_type: {
          type: "string",
          description: "Optional subagent type",
        },
      },
      required: ["description"],
    },
  },

  CLIENT_SIDE_TOOL_V2_TASK_V2: {
    name: "task",
    description: "Delegate a task/sub-agent execution request",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Task description" },
        prompt: { type: "string", description: "Task prompt" },
        model: { type: "string", description: "Optional model override" },
        subagent_type: {
          type: "string",
          description: "Optional subagent type",
        },
      },
      required: ["description"],
    },
  },

  CLIENT_SIDE_TOOL_V2_TODO_READ: {
    name: "read_todos",
    description: "Read current todo items and optional filtered subsets",
    input_schema: {
      type: "object",
      properties: {
        status_filter: {
          type: "array",
          description:
            "Optional todo status filter (pending/in_progress/completed/cancelled)",
          items: { type: "string" },
        },
        id_filter: {
          type: "array",
          description: "Optional todo id filter",
          items: { type: "string" },
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_TODO_WRITE: {
    name: "update_todos",
    description: "Update todo items, optionally merging into current list",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Todo objects to write",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Stable todo id",
              },
              content: {
                type: "string",
                description: "Human-readable todo text",
              },
              status: {
                type: "string",
                description:
                  "Todo status enum (TODO_STATUS_PENDING/IN_PROGRESS/COMPLETED/CANCELLED)",
              },
              dependencies: {
                type: "array",
                description: "Optional upstream todo ids",
                items: { type: "string" },
              },
              createdAt: {
                type: "string",
                description: "Optional creation timestamp (unix ms)",
              },
              updatedAt: {
                type: "string",
                description: "Optional update timestamp (unix ms)",
              },
            },
            required: ["id", "content", "status"],
          },
        },
        merge: {
          type: "boolean",
          description: "Whether to merge with existing todos",
        },
      },
      required: ["todos"],
    },
  },

  CLIENT_SIDE_TOOL_V2_DEEP_SEARCH: {
    name: "deep_search",
    description: "Perform a deep semantic search across the entire codebase",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The deep search query" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES: {
    name: "read_semsearch_files",
    description: "Read files returned by semantic search candidates",
    input_schema: {
      type: "object",
      properties: {
        file_paths: {
          type: "array",
          items: { type: "string" },
          description: "Semantic search candidate file paths",
        },
      },
      required: ["file_paths"],
    },
  },

  CLIENT_SIDE_TOOL_V2_REAPPLY: {
    name: "reapply",
    description: "Reapply a previously suggested patch or diff",
    input_schema: {
      type: "object",
      properties: {
        patch: { type: "string", description: "Patch content to reapply" },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_FETCH_RULES: {
    name: "fetch_rules",
    description: "Fetch active project/agent rules for current conversation",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS: {
    name: "search_symbols",
    description: "Search symbols in workspace index",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol query" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP: {
    name: "background_composer_followup",
    description: "Submit a follow-up message to a background composer task",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Follow-up user message" },
      },
      required: ["message"],
    },
  },

  CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE: {
    name: "knowledge_base",
    description: "Query knowledge base for supporting information",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Knowledge base query" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST: {
    name: "fetch_pull_request",
    description: "Fetch pull request metadata/content by URL or identifier",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Pull request URL" },
        id: { type: "string", description: "Optional pull request identifier" },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM: {
    name: "create_diagram",
    description:
      "Create an architecture or flow diagram from text instructions",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Diagram creation prompt" },
      },
      required: ["prompt"],
    },
  },

  CLIENT_SIDE_TOOL_V2_FIX_LINTS: {
    name: "fix_lints",
    description: "Apply automatic lint fixes for targeted files",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Files to lint-fix",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION: {
    name: "go_to_definition",
    description: "Resolve symbol definition location",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol name or token" },
        path: { type: "string", description: "Optional current file path" },
      },
      required: ["symbol"],
    },
  },

  CLIENT_SIDE_TOOL_V2_AWAIT_TASK: {
    name: "await_task",
    description: "Wait for previously launched task/sub-agent completion",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task identifier" },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_READ_PROJECT: {
    name: "read_project",
    description: "Read project-level settings and metadata",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Optional project key selector" },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT: {
    name: "update_project",
    description: "Update project-level settings and metadata",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Project key to update" },
        value: { type: "string", description: "Value to set" },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_MCP: {
    name: "mcp_tool",
    description: "Call a Model Context Protocol tool",
    input_schema: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "MCP server name" },
        tool_name: { type: "string", description: "Tool name to call" },
        arguments: { type: "object", description: "Tool arguments" },
      },
      required: ["server_name", "tool_name"],
    },
  },

  CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL: {
    name: "mcp_tool",
    description: "Call a Model Context Protocol tool",
    input_schema: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "MCP server name" },
        tool_name: { type: "string", description: "Tool name to call" },
        arguments: { type: "object", description: "Tool arguments" },
      },
      required: ["server_name", "tool_name"],
    },
  },

  CLIENT_SIDE_TOOL_V2_DIAGNOSTICS: {
    name: "read_lints",
    description: "Read lint/diagnostic warnings and errors for files",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "File paths to check for diagnostics",
        },
      },
      required: ["paths"],
    },
  },

  CLIENT_SIDE_TOOL_V2_READ_LINTS: {
    name: "read_lints",
    description: "Read lint/diagnostic warnings and errors for files",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "File paths to check for diagnostics",
        },
      },
      required: ["paths"],
    },
  },

  CLIENT_SIDE_TOOL_V2_ASK_FOLLOWUP_QUESTION: {
    name: "ask_question",
    description: "Ask a follow-up question to the user",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask" },
        title: { type: "string", description: "Question panel title" },
        questions: {
          type: "array",
          description: "Structured question list for interactive UI selection",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Question identifier" },
              prompt: { type: "string", description: "Question prompt text" },
              options: {
                type: "array",
                description: "Selectable options for this question",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Option identifier" },
                    label: { type: "string", description: "Option label" },
                  },
                  required: ["id", "label"],
                },
              },
              allow_multiple: {
                type: "boolean",
                description: "Allow selecting multiple options",
              },
            },
            required: ["prompt"],
          },
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_ASK_QUESTION: {
    name: "ask_question",
    description: "Ask a follow-up question to the user",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask" },
        title: { type: "string", description: "Question panel title" },
        questions: {
          type: "array",
          description: "Structured question list for interactive UI selection",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Question identifier" },
              prompt: { type: "string", description: "Question prompt text" },
              options: {
                type: "array",
                description: "Selectable options for this question",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Option identifier" },
                    label: { type: "string", description: "Option label" },
                  },
                  required: ["id", "label"],
                },
              },
              allow_multiple: {
                type: "boolean",
                description: "Allow selecting multiple options",
              },
            },
            required: ["prompt"],
          },
        },
        run_async: {
          type: "boolean",
          description: "Whether to run asynchronously",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_SWITCH_MODE: {
    name: "switch_mode",
    description: "Switch the current agent mode",
    input_schema: {
      type: "object",
      properties: {
        targetModeId: { type: "string", description: "Target mode id" },
        explanation: {
          type: "string",
          description: "Why the mode switch is needed",
        },
      },
      required: ["targetModeId"],
    },
  },

  CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES: {
    name: "list_mcp_resources",
    description: "List resources from an MCP server",
    input_schema: {
      type: "object",
      properties: {
        serverName: { type: "string", description: "MCP server name" },
      },
      required: ["serverName"],
    },
  },

  CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE: {
    name: "read_mcp_resource",
    description: "Read a resource from an MCP server",
    input_schema: {
      type: "object",
      properties: {
        serverName: { type: "string", description: "MCP server name" },
        uri: { type: "string", description: "Resource URI to read" },
      },
      required: ["serverName", "uri"],
    },
  },

  CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS: {
    name: "get_mcp_tools",
    description: "List MCP tools currently available to the agent",
    input_schema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Optional MCP server filter",
        },
        tool_name: {
          type: "string",
          description: "Optional MCP tool name filter",
        },
        pattern: {
          type: "string",
          description: "Optional fuzzy match across tool metadata",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_EXA_SEARCH: {
    name: "exa_search",
    description: "Search the web using Exa",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        type: { type: "string", description: "Optional result type" },
        num_results: {
          type: "number",
          description: "Maximum number of results",
        },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_EXA_FETCH: {
    name: "exa_fetch",
    description: "Fetch documents by Exa ids or URLs",
    input_schema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Document ids or URLs to fetch",
        },
      },
      required: ["ids"],
    },
  },

  CLIENT_SIDE_TOOL_V2_SETUP_VM_ENVIRONMENT: {
    name: "setup_vm_environment",
    description: "Setup VM environment commands for the current task",
    input_schema: {
      type: "object",
      properties: {
        installCommand: {
          type: "string",
          description: "Install/dependency command",
        },
        startCommand: {
          type: "string",
          description: "Start command after setup",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF: {
    name: "apply_agent_diff",
    description: "Apply an agent-produced diff payload",
    input_schema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent identifier" },
        diff: { type: "string", description: "Unified diff to apply" },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE: {
    name: "generate_image",
    description: "Generate an image artifact from a prompt",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Image generation prompt" },
        filePath: {
          type: "string",
          description: "Optional output file path",
        },
      },
      required: ["prompt"],
    },
  },

  CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS: {
    name: "report_bugfix_results",
    description: "Report bugfix verification results",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Bugfix summary" },
        results: {
          type: "array",
          description: "Structured bugfix results",
          items: { type: "object" },
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_BACKGROUND_SHELL_SPAWN: {
    name: "background_shell_spawn",
    description: "Spawn a long-running background process",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        cwd: { type: "string", description: "Working directory" },
      },
      required: ["command"],
    },
  },

  CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN: {
    name: "write_shell_stdin",
    description: "Write input to a running shell process",
    input_schema: {
      type: "object",
      properties: {
        shellId: { type: "number", description: "The shell process ID" },
        data: { type: "string", description: "The data to write" },
      },
      required: ["shellId", "data"],
    },
  },

  CLIENT_SIDE_TOOL_V2_RECORD_SCREEN: {
    name: "record_screen",
    description: "Start/save/discard screen recording in IDE",
    input_schema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: "Recording mode such as start/save/discard",
        },
        saveAsFilename: {
          type: "string",
          description: "Optional file name when saving recording",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_REFLECT: {
    name: "reflect",
    description: "Run reflective reasoning before continuing execution",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_START_GRIND_EXECUTION: {
    name: "start_grind_execution",
    description: "Start grind execution workflow",
    input_schema: {
      type: "object",
      properties: {
        explanation: {
          type: "string",
          description: "Optional explanation for the execution request",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_START_GRIND_PLANNING: {
    name: "start_grind_planning",
    description: "Start grind planning workflow",
    input_schema: {
      type: "object",
      properties: {
        explanation: {
          type: "string",
          description: "Optional explanation for the planning request",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_COMPUTER_USE: {
    name: "computer_use",
    description: "Perform computer-use actions in IDE automation sandbox",
    input_schema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description: "Computer-use action list",
          items: { type: "object" },
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_FETCH: {
    name: "fetch",
    description: "Fetch content from a URL",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },
}

const PREFERRED_CURSOR_KEY_BY_TOOL_NAME: Record<string, string> = {
  ask_question: "CLIENT_SIDE_TOOL_V2_ASK_QUESTION",
  create_plan: "CLIENT_SIDE_TOOL_V2_CREATE_PLAN",
  switch_mode: "CLIENT_SIDE_TOOL_V2_SWITCH_MODE",
  mcp_tool: "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL",
  web_search: "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
  web_fetch: "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
  exa_search: "CLIENT_SIDE_TOOL_V2_EXA_SEARCH",
  exa_fetch: "CLIENT_SIDE_TOOL_V2_EXA_FETCH",
  setup_vm_environment: "CLIENT_SIDE_TOOL_V2_SETUP_VM_ENVIRONMENT",
  read_lints: "CLIENT_SIDE_TOOL_V2_READ_LINTS",
  list_mcp_resources: "CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES",
  read_mcp_resource: "CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE",
  get_mcp_tools: "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
  task: "CLIENT_SIDE_TOOL_V2_TASK_V2",
  read_todos: "CLIENT_SIDE_TOOL_V2_TODO_READ",
  update_todos: "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
  apply_agent_diff: "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF",
  generate_image: "CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE",
  report_bugfix_results: "CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS",
  read_semsearch_files: "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES",
  reapply: "CLIENT_SIDE_TOOL_V2_REAPPLY",
  fetch_rules: "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
  search_symbols: "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
  background_composer_followup:
    "CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP",
  knowledge_base: "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE",
  fetch_pull_request: "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST",
  create_diagram: "CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM",
  fix_lints: "CLIENT_SIDE_TOOL_V2_FIX_LINTS",
  go_to_definition: "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
  await_task: "CLIENT_SIDE_TOOL_V2_AWAIT_TASK",
  read_project: "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
  update_project: "CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT",
  reflect: "CLIENT_SIDE_TOOL_V2_REFLECT",
  start_grind_execution: "CLIENT_SIDE_TOOL_V2_START_GRIND_EXECUTION",
  start_grind_planning: "CLIENT_SIDE_TOOL_V2_START_GRIND_PLANNING",
}

const TOOL_KEY_ALIASES: Record<string, string> = {
  client_side_tool_v2_ask_followup_question: "CLIENT_SIDE_TOOL_V2_ASK_QUESTION",
  client_side_tool_v2_diagnostics: "CLIENT_SIDE_TOOL_V2_READ_LINTS",
  client_side_tool_v2_call_mcp_tool: "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL",
  client_side_tool_v2_read_file: "CLIENT_SIDE_TOOL_V2_READ_FILE",
  client_side_tool_v2_list_dir: "CLIENT_SIDE_TOOL_V2_LIST_DIR",
  client_side_tool_v2_ripgrep_search: "CLIENT_SIDE_TOOL_V2_RIPGREP_SEARCH",
  client_side_tool_v2_record_screen: "CLIENT_SIDE_TOOL_V2_RECORD_SCREEN",
  client_side_tool_v2_computer_use: "CLIENT_SIDE_TOOL_V2_COMPUTER_USE",
  client_side_tool_v2_task: "CLIENT_SIDE_TOOL_V2_TASK",
  client_side_tool_v2_task_v2: "CLIENT_SIDE_TOOL_V2_TASK_V2",
  client_side_tool_v2_todo_read: "CLIENT_SIDE_TOOL_V2_TODO_READ",
  client_side_tool_v2_todo_write: "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
  client_side_tool_v2_apply_agent_diff: "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF",
  client_side_tool_v2_generate_image: "CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE",
  client_side_tool_v2_report_bugfix_results:
    "CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS",
  client_side_tool_v2_read_semsearch_files:
    "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES",
  client_side_tool_v2_reapply: "CLIENT_SIDE_TOOL_V2_REAPPLY",
  client_side_tool_v2_fetch_rules: "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
  client_side_tool_v2_search_symbols: "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
  client_side_tool_v2_background_composer_followup:
    "CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP",
  client_side_tool_v2_knowledge_base: "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE",
  client_side_tool_v2_fetch_pull_request:
    "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST",
  client_side_tool_v2_create_diagram: "CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM",
  client_side_tool_v2_fix_lints: "CLIENT_SIDE_TOOL_V2_FIX_LINTS",
  client_side_tool_v2_go_to_definition: "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
  client_side_tool_v2_await_task: "CLIENT_SIDE_TOOL_V2_AWAIT_TASK",
  client_side_tool_v2_read_project: "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
  client_side_tool_v2_update_project: "CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT",
  client_side_tool_v2_reflect: "CLIENT_SIDE_TOOL_V2_REFLECT",
  client_side_tool_v2_start_grind_execution:
    "CLIENT_SIDE_TOOL_V2_START_GRIND_EXECUTION",
  client_side_tool_v2_start_grind_planning:
    "CLIENT_SIDE_TOOL_V2_START_GRIND_PLANNING",
  client_side_tool_v2_exa_search: "CLIENT_SIDE_TOOL_V2_EXA_SEARCH",
  client_side_tool_v2_exa_fetch: "CLIENT_SIDE_TOOL_V2_EXA_FETCH",
  client_side_tool_v2_setup_vm_environment:
    "CLIENT_SIDE_TOOL_V2_SETUP_VM_ENVIRONMENT",
  web_search: "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
  web_fetch: "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
  ask_question: "CLIENT_SIDE_TOOL_V2_ASK_QUESTION",
  create_plan: "CLIENT_SIDE_TOOL_V2_CREATE_PLAN",
  switch_mode: "CLIENT_SIDE_TOOL_V2_SWITCH_MODE",
  exa_search: "CLIENT_SIDE_TOOL_V2_EXA_SEARCH",
  exa_fetch: "CLIENT_SIDE_TOOL_V2_EXA_FETCH",
  setup_vm_environment: "CLIENT_SIDE_TOOL_V2_SETUP_VM_ENVIRONMENT",
  list_mcp_resources: "CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES",
  read_mcp_resource: "CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE",
  client_side_tool_v2_get_mcp_tools: "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
  get_mcp_tools: "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
  read_lints: "CLIENT_SIDE_TOOL_V2_READ_LINTS",
  task: "CLIENT_SIDE_TOOL_V2_TASK_V2",
  read_todos: "CLIENT_SIDE_TOOL_V2_TODO_READ",
  update_todos: "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
  todo_read: "CLIENT_SIDE_TOOL_V2_TODO_READ",
  todo_write: "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
  apply_agent_diff: "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF",
  generate_image: "CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE",
  report_bugfix_results: "CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS",
  read_semsearch_files: "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES",
  reapply: "CLIENT_SIDE_TOOL_V2_REAPPLY",
  fetch_rules: "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
  search_symbols: "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
  background_composer_followup:
    "CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP",
  knowledge_base: "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE",
  fetch_pull_request: "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST",
  create_diagram: "CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM",
  fix_lints: "CLIENT_SIDE_TOOL_V2_FIX_LINTS",
  go_to_definition: "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
  await_task: "CLIENT_SIDE_TOOL_V2_AWAIT_TASK",
  read_project: "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
  update_project: "CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT",
  reflect: "CLIENT_SIDE_TOOL_V2_REFLECT",
  start_grind_execution: "CLIENT_SIDE_TOOL_V2_START_GRIND_EXECUTION",
  start_grind_planning: "CLIENT_SIDE_TOOL_V2_START_GRIND_PLANNING",
}

const DEFAULT_AGENT_BUILTIN_CURSOR_TOOLS = [
  "CLIENT_SIDE_TOOL_V2_READ_FILE_V2",
  "CLIENT_SIDE_TOOL_V2_LIST_DIR_V2",
  "CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH",
  "CLIENT_SIDE_TOOL_V2_FILE_SEARCH",
  "CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH",
  "CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL",
  "CLIENT_SIDE_TOOL_V2_DEEP_SEARCH",
  "CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2",
  "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2",
  "CLIENT_SIDE_TOOL_V2_DELETE_FILE",
  "CLIENT_SIDE_TOOL_V2_READ_LINTS",
  "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
  "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
  "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
  "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
  "CLIENT_SIDE_TOOL_V2_TASK_V2",
  "CLIENT_SIDE_TOOL_V2_AWAIT_TASK",
  "CLIENT_SIDE_TOOL_V2_TODO_READ",
  "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
  "CLIENT_SIDE_TOOL_V2_ASK_QUESTION",
  "CLIENT_SIDE_TOOL_V2_CREATE_PLAN",
  "CLIENT_SIDE_TOOL_V2_SWITCH_MODE",
  "CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES",
  "CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE",
  "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
  "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL",
  "CLIENT_SIDE_TOOL_V2_BACKGROUND_SHELL_SPAWN",
  "CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN",
  "CLIENT_SIDE_TOOL_V2_FETCH",
  "CLIENT_SIDE_TOOL_V2_RECORD_SCREEN",
  "CLIENT_SIDE_TOOL_V2_COMPUTER_USE",
  "CLIENT_SIDE_TOOL_V2_REFLECT",
  "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF",
  "CLIENT_SIDE_TOOL_V2_REAPPLY",
  "CLIENT_SIDE_TOOL_V2_FIX_LINTS",
  "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES",
  "CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP",
  "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE",
  "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST",
  "CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM",
  "CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT",
  "CLIENT_SIDE_TOOL_V2_SETUP_VM_ENVIRONMENT",
  "CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE",
  "CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS",
  "CLIENT_SIDE_TOOL_V2_START_GRIND_EXECUTION",
  "CLIENT_SIDE_TOOL_V2_START_GRIND_PLANNING",
  "CLIENT_SIDE_TOOL_V2_EXA_SEARCH",
  "CLIENT_SIDE_TOOL_V2_EXA_FETCH",
  "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
  "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
] as const

const BUILTIN_CURSOR_TOOL_KEYS = new Set<string>(
  DEFAULT_AGENT_BUILTIN_CURSOR_TOOLS
)

const BUILTIN_WEB_SEARCH_TOOL_KEYS = new Set<string>([
  "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
])

const BUILTIN_WEB_FETCH_TOOL_KEYS = new Set<string>([
  "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
])

const BUILTIN_LINT_TOOL_KEYS = new Set<string>([
  "CLIENT_SIDE_TOOL_V2_DIAGNOSTICS",
  "CLIENT_SIDE_TOOL_V2_READ_LINTS",
])

function normalizeToolIdentifier(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
}

function resolveToolDefinitionKey(rawTool: string): string | undefined {
  if (!rawTool) return undefined

  const normalized = normalizeToolIdentifier(rawTool)
  const alias = TOOL_KEY_ALIASES[normalized]
  if (alias && CURSOR_TOOL_DEFINITIONS[alias]) {
    return alias
  }

  if (CURSOR_TOOL_DEFINITIONS[rawTool]) {
    return rawTool
  }

  for (const [key, definition] of Object.entries(CURSOR_TOOL_DEFINITIONS)) {
    if (normalizeToolIdentifier(key) === normalized) {
      return key
    }
    if (normalizeToolIdentifier(definition.name) === normalized) {
      return key
    }
  }

  return undefined
}

export function resolveCursorToolDefinitionKey(
  rawTool: string
): string | undefined {
  return resolveToolDefinitionKey(rawTool)
}

/**
 * Convert Cursor supportedTools list to Anthropic tool definitions
 */
export function mapCursorToolsToAnthropic(
  supportedTools: string[]
): AnthropicTool[] {
  const tools: AnthropicTool[] = []
  const seen = new Set<string>()

  for (const cursorTool of supportedTools) {
    const definitionKey = resolveToolDefinitionKey(cursorTool)
    if (!definitionKey || seen.has(definitionKey)) continue
    seen.add(definitionKey)

    const definition = CURSOR_TOOL_DEFINITIONS[definitionKey]
    if (definition) {
      tools.push(definition)
    }
  }

  return tools
}

/**
 * Map Anthropic tool_use response back to Cursor tool name
 */
export function mapAnthropicToolToCursor(anthropicToolName: string): string {
  const normalizedName = normalizeToolIdentifier(anthropicToolName)
  const preferred = PREFERRED_CURSOR_KEY_BY_TOOL_NAME[normalizedName]
  if (preferred && CURSOR_TOOL_DEFINITIONS[preferred]) {
    return preferred
  }

  // Reverse lookup
  for (const [cursorName, def] of Object.entries(CURSOR_TOOL_DEFINITIONS)) {
    if (def.name === anthropicToolName) {
      return cursorName
    }
  }
  // If no mapping found, return as-is (might be a custom tool)
  return anthropicToolName
}

/**
 * Get all available tool names for logging/debugging
 */
export function getAvailableTools(): string[] {
  return Object.keys(CURSOR_TOOL_DEFINITIONS)
}

function shouldIncludeBuiltInTool(
  definitionKey: string,
  options?: CursorBuiltInToolCapabilityOptions
): boolean {
  const hasExplicitWebCapability =
    options?.webSearchEnabled !== undefined ||
    options?.webFetchEnabled !== undefined

  if (BUILTIN_WEB_SEARCH_TOOL_KEYS.has(definitionKey)) {
    return hasExplicitWebCapability ? options?.webSearchEnabled === true : true
  }

  if (BUILTIN_WEB_FETCH_TOOL_KEYS.has(definitionKey)) {
    return hasExplicitWebCapability ? options?.webFetchEnabled === true : true
  }

  if (BUILTIN_LINT_TOOL_KEYS.has(definitionKey)) {
    if (options?.readLintsEnabled === false) return false
  }

  return true
}

export function getDefaultAgentToolNames(
  options?: CursorBuiltInToolCapabilityOptions
): string[] {
  return DEFAULT_AGENT_BUILTIN_CURSOR_TOOLS.filter((toolName) =>
    shouldIncludeBuiltInTool(toolName, options)
  )
}

export function isCursorBuiltInToolAllowed(
  toolName: string,
  options?: CursorBuiltInToolCapabilityOptions
): boolean {
  if (!BUILTIN_CURSOR_TOOL_KEYS.has(toolName)) {
    return true
  }
  return shouldIncludeBuiltInTool(toolName, options)
}

// ToolDefinition format compatible with CreateMessageDto
export interface McpToolDefinitionForApi {
  name: string
  toolName?: string
  providerIdentifier?: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface BuildToolsForApiOptions {
  mcpToolDefs?: McpToolDefinitionForApi[]
}

export interface CursorBuiltInToolCapabilityOptions {
  webSearchEnabled?: boolean
  webFetchEnabled?: boolean
  readLintsEnabled?: boolean
}

export interface ToolDefinition {
  type: "function"
  name: string
  description: string
  input_schema: Record<string, unknown>
}

function normalizeToolInputSchema(
  schema: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return {
      type: "object",
      properties: {},
    }
  }
  const normalizedType =
    typeof schema.type === "string" && schema.type.length > 0
      ? schema.type
      : "object"
  const properties =
    normalizedType === "object" &&
    schema.properties &&
    typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : {}
  return {
    ...schema,
    type: normalizedType,
    ...(normalizedType === "object" ? { properties } : {}),
  }
}

/**
 * Build tool definitions for the API backend (CreateMessageDto format).
 * This is the single source of truth — replaces the duplicate buildToolDefinitions
 * in cursor-connect-stream.service.ts.
 */
export function buildToolsForApi(
  supportedTools: string[],
  options?: BuildToolsForApiOptions
): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  const executableViaExecServerMessage = new Set<string>([
    "CLIENT_SIDE_TOOL_V2_READ_FILE",
    "CLIENT_SIDE_TOOL_V2_READ_FILE_V2",
    "CLIENT_SIDE_TOOL_V2_LIST_DIR",
    "CLIENT_SIDE_TOOL_V2_LIST_DIR_V2",
    "CLIENT_SIDE_TOOL_V2_EDIT_FILE",
    "CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2",
    "CLIENT_SIDE_TOOL_V2_RIPGREP_SEARCH",
    "CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH",
    "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2",
    "CLIENT_SIDE_TOOL_V2_DELETE_FILE",
    "CLIENT_SIDE_TOOL_V2_MCP",
    "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL",
    "CLIENT_SIDE_TOOL_V2_DIAGNOSTICS",
    "CLIENT_SIDE_TOOL_V2_READ_LINTS",
    "CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES",
    "CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE",
    "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
    "CLIENT_SIDE_TOOL_V2_ASK_QUESTION",
    "CLIENT_SIDE_TOOL_V2_ASK_FOLLOWUP_QUESTION",
    "CLIENT_SIDE_TOOL_V2_CREATE_PLAN",
    "CLIENT_SIDE_TOOL_V2_SWITCH_MODE",
    "CLIENT_SIDE_TOOL_V2_BACKGROUND_SHELL_SPAWN",
    "CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN",
    "CLIENT_SIDE_TOOL_V2_RECORD_SCREEN",
    "CLIENT_SIDE_TOOL_V2_COMPUTER_USE",
    "CLIENT_SIDE_TOOL_V2_FETCH",
    // Deferred / inline interaction tools.
    "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
    "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
    "CLIENT_SIDE_TOOL_V2_EXA_SEARCH",
    "CLIENT_SIDE_TOOL_V2_EXA_FETCH",
    "CLIENT_SIDE_TOOL_V2_SETUP_VM_ENVIRONMENT",
    "CLIENT_SIDE_TOOL_V2_TASK",
    "CLIENT_SIDE_TOOL_V2_TASK_V2",
    "CLIENT_SIDE_TOOL_V2_TODO_READ",
    "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
    "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF",
    "CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE",
    "CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS",
    "CLIENT_SIDE_TOOL_V2_FIX_LINTS",
    "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES",
    "CLIENT_SIDE_TOOL_V2_REAPPLY",
    "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
    "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
    "CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP",
    "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE",
    "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST",
    "CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM",
    "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
    "CLIENT_SIDE_TOOL_V2_AWAIT_TASK",
    "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
    "CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT",
    "CLIENT_SIDE_TOOL_V2_REFLECT",
    "CLIENT_SIDE_TOOL_V2_START_GRIND_EXECUTION",
    "CLIENT_SIDE_TOOL_V2_START_GRIND_PLANNING",
    "CLIENT_SIDE_TOOL_V2_FILE_SEARCH",
    "CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL",
    "CLIENT_SIDE_TOOL_V2_DEEP_SEARCH",
    "CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH",
  ])
  const seenDefinitionKeys = new Set<string>()
  const seenToolNames = new Set<string>()
  const mcpDefByNormalizedName = new Map<string, McpToolDefinitionForApi>()

  for (const mcpToolDef of options?.mcpToolDefs || []) {
    if (!mcpToolDef || typeof mcpToolDef.name !== "string") continue
    const normalizedFullName = normalizeToolIdentifier(mcpToolDef.name)
    if (normalizedFullName && !mcpDefByNormalizedName.has(normalizedFullName)) {
      mcpDefByNormalizedName.set(normalizedFullName, mcpToolDef)
    }
    if (typeof mcpToolDef.toolName === "string" && mcpToolDef.toolName) {
      const normalizedToolName = normalizeToolIdentifier(mcpToolDef.toolName)
      if (
        normalizedToolName &&
        !mcpDefByNormalizedName.has(normalizedToolName)
      ) {
        mcpDefByNormalizedName.set(normalizedToolName, mcpToolDef)
      }
    }
  }

  for (const cursorTool of supportedTools) {
    const definitionKey = resolveToolDefinitionKey(cursorTool)
    if (definitionKey && !seenDefinitionKeys.has(definitionKey)) {
      // AgentService/Run currently dispatches tool execution via ExecServerMessage.
      // Keep the exposed tool list aligned with that executable subset to avoid
      // protocol-invalid fallbacks for unsupported tool families.
      if (!executableViaExecServerMessage.has(definitionKey)) {
        continue
      }

      const definition = CURSOR_TOOL_DEFINITIONS[definitionKey]
      if (definition) {
        const normalizedToolName = normalizeToolIdentifier(definition.name)
        if (seenToolNames.has(normalizedToolName)) {
          continue
        }
        seenDefinitionKeys.add(definitionKey)
        seenToolNames.add(normalizedToolName)
        tools.push({
          type: "function",
          ...definition,
        })
      }
      continue
    }

    const normalizedCursorTool = normalizeToolIdentifier(cursorTool)
    const mcpToolDef = mcpDefByNormalizedName.get(normalizedCursorTool)
    if (!mcpToolDef || !mcpToolDef.name) continue

    const normalizedMcpName = normalizeToolIdentifier(mcpToolDef.name)
    if (!normalizedMcpName || seenToolNames.has(normalizedMcpName)) continue

    seenToolNames.add(normalizedMcpName)
    tools.push({
      type: "function",
      name: mcpToolDef.name,
      description:
        mcpToolDef.description ||
        `MCP tool ${mcpToolDef.toolName || mcpToolDef.name}`,
      input_schema: normalizeToolInputSchema(mcpToolDef.inputSchema),
    })
  }

  return tools
}

/**
 * Get default tools for agent mode (when supportedTools is empty)
 */
export function getDefaultAgentTools(
  options?: CursorBuiltInToolCapabilityOptions
): AnthropicTool[] {
  return mapCursorToolsToAnthropic(getDefaultAgentToolNames(options))
}

/**
 * Get the ClientSideToolV2Type enum value for a given tool name
 *
 * NOTE: These values are extracted from Cursor source code static analysis.
 * The generated proto file has outdated values, so we hardcode the correct ones.
 */
export function getToolTypeEnumValue(toolName: string): number {
  // Corrected enum values from Cursor source analysis (2026-01-19)
  const TOOL_ENUM_VALUES: Record<string, number> = {
    CLIENT_SIDE_TOOL_V2_READ_FILE: 5,
    CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES: 1,
    CLIENT_SIDE_TOOL_V2_LIST_DIR: 6,
    CLIENT_SIDE_TOOL_V2_EDIT_FILE: 7,
    CLIENT_SIDE_TOOL_V2_RIPGREP_SEARCH: 3,
    CLIENT_SIDE_TOOL_V2_FILE_SEARCH: 8,
    CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL: 9,
    CLIENT_SIDE_TOOL_V2_DEEP_SEARCH: 27,
    CLIENT_SIDE_TOOL_V2_DELETE_FILE: 11,
    CLIENT_SIDE_TOOL_V2_REAPPLY: 12,
    CLIENT_SIDE_TOOL_V2_FETCH_RULES: 16,
    CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2: 15,
    CLIENT_SIDE_TOOL_V2_WEB_SEARCH: 18,
    CLIENT_SIDE_TOOL_V2_MCP: 19,
    CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS: 23,
    CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP: 24,
    CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE: 25,
    CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST: 26,
    CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM: 28,
    CLIENT_SIDE_TOOL_V2_FIX_LINTS: 29,
    CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION: 31,
    CLIENT_SIDE_TOOL_V2_WEB_FETCH: 57,
    CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2: 38,
    CLIENT_SIDE_TOOL_V2_LIST_DIR_V2: 39,
    CLIENT_SIDE_TOOL_V2_READ_FILE_V2: 40,
    CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH: 41,
    CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH: 42,
    CLIENT_SIDE_TOOL_V2_CREATE_PLAN: 43,
    CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES: 44,
    CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE: 45,
    CLIENT_SIDE_TOOL_V2_READ_PROJECT: 46,
    CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT: 47,
    CLIENT_SIDE_TOOL_V2_TASK: 32,
    CLIENT_SIDE_TOOL_V2_AWAIT_TASK: 33,
    CLIENT_SIDE_TOOL_V2_TASK_V2: 48,
    CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL: 49,
    CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF: 50,
    CLIENT_SIDE_TOOL_V2_ASK_QUESTION: 51,
    CLIENT_SIDE_TOOL_V2_SWITCH_MODE: 52,
    CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE: 53,
    CLIENT_SIDE_TOOL_V2_COMPUTER_USE: 54,
    CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN: 55,
    CLIENT_SIDE_TOOL_V2_RECORD_SCREEN: 56,
    CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS: 58,
    CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS: 63,
    CLIENT_SIDE_TOOL_V2_READ_LINTS: 30,
    CLIENT_SIDE_TOOL_V2_TODO_READ: 34,
    CLIENT_SIDE_TOOL_V2_TODO_WRITE: 35,
  }

  // 1. Direct match on tool name
  const directValue = TOOL_ENUM_VALUES[toolName]
  if (directValue !== undefined) {
    return directValue
  }

  // 2. Find the Cursor tool key by anthropic name
  for (const [key, def] of Object.entries(CURSOR_TOOL_DEFINITIONS)) {
    const enumValue = TOOL_ENUM_VALUES[key]
    if (def.name === toolName && enumValue !== undefined) {
      return enumValue
    }
  }

  // Default: UNSPECIFIED = 0
  return 0
}
