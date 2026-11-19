# Context Fold

Context Fold is an optional extension for built-in Asterism Agents. It replaces images from earlier turns' completed tool results with recall tickets in model requests. Current-turn images, tool text, and user attachments are unchanged. A recall returns the exact saved image as a new tool result; it does not run the original tool again. A recalled image can fold back to the same ticket in a later turn.

Folding changes the model request, not the conversation history. Turn boundaries can still invalidate a model provider's cached prefix. The plugin batches folding at those boundaries and does not evict more images during a long turn.

Add this built package in the plugin settings and restart. The host must expose the Agent context transform through the built-in Agent API. Disable the plugin and restart to use the ordinary projection again.
