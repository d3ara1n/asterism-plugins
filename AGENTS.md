# Asterism Plugins

This npm workspace contains companion plugins for internal testing of Asterism's plugin system. Each plugin should exercise a specific host capability and make the expected behavior easy to verify. During internal testing, the distribution workflow is clone → build locally → load manually in Asterism. Do not publish to npm or add publishing automation during this phase.

## Add or change a plugin

- Keep each plugin in its own workspace under `plugins/`. In the plugin's README, name the host capability it exercises and give the tester an observable result to check.
- Use `@asterism-plugins/<name>` for official companion plugins (for example, `@asterism-plugins/context-fold`). Reserve `@asterism-app` for Asterism core and framework packages. Third-party authors use their own scope with an `asterism-` package prefix (for example, `@alice/asterism-my-plugin`).
- The npm package name and the runtime plugin ID (`asterism.id` in the package manifest) are distinct. Keep the runtime ID stable on a package rename unless the intent is to change the plugin's identity.

## Set up and verify locally

1. Keep this checkout beside a compatible Asterism source checkout named `asterism`. The workspace's `file:` dependencies use that checkout's API and builder. For Context Fold, the host must include the tool-result projection hook.
2. In the Asterism checkout, install its dependencies and run `npm run build:plugin-tool`. In this repository, run `npm ci`. A successful `npm ci` alone does not prove the sibling builder is available.
3. After changing plugin code or its manifest, run `npm run typecheck`, `npm test`, and `npm run build` from this repository's root. Keep generated `dist/` files out of Git.
4. For changes to loading or runtime behavior, add the built plugin's package directory (for example, `plugins/context-fold`, not `dist/`) in Asterism's plugin settings, restart, and reproduce the expected behavior. If the required host checkout or hook is unavailable, report the blocked check rather than treating a successful build as host verification.

## Git Commit

- Use Conventional Commits with a lowercase English type. Show the diff or summary and obtain explicit permission before committing.
- AI-assisted commits include both a `Co-Authored-By` trailer for the model and an `Agent-Harness` trailer for the agent software in one contiguous trailer block after the body:
  ```text
  Co-Authored-By: <model-id> <provider-noreply>
  Agent-Harness: <harness-name> (<harness-url>)
  ```
  - **Model ID**: Obtain the actual model name from available environment information before each commit rather than reusing an earlier trailer, and extract the vendor's model ID; ask the user only when it cannot be determined. Drop relay prefixes (such as `provider/`), channel markers (such as `[Kiro]`), and variant suffixes (such as `-thinking` or `-high`), so `[Kiro]claude-opus-5-5-thinking` becomes `claude-opus-5-5`.
  - **Provider email**: Always use the model vendor's noreply address regardless of relay or channel: `noreply@anthropic.com` (`claude-*`), `noreply@openai.com` (`gpt-*`, `o1*`, `o3*`, `o4*`, `codex-*`), `noreply@google.com` (`gemini-*`), `noreply@x.ai` (`grok-*`), `noreply@deepseek.com` (`deepseek-*`), `noreply@qwenlm.ai` (`qwen*`), `noreply@zhipuai.cn` (`glm-*`), `noreply@moonshot.cn` (`kimi-*`), or the known vendor's noreply address for other vendors. Only when the model vendor is genuinely unknown, use `noreply@unknown.invalid`; never invent a vendor domain or reuse an unrelated tool domain.
  - **Agent harness**: Identify the agent software from available environment information and include its canonical homepage URL in parentheses when known (for example, `Agent-Harness: Asterism (https://asterism.dearain.dev)`). If the harness URL is unknown, omit the parenthesized URL and write only `<harness-name>` rather than guessing.
