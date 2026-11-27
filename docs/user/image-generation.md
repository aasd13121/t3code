# Generate images with a model API

Add an API under **Settings → Providers → Image model providers** and turn it on. The endpoint must support the OpenAI Images API. You can enter its root URL, its `/v1` base URL, or its full `/images/generations` URL.

In a conversation, ask the agent to generate an image. Agents can find your configured APIs with `list_image_generators` and ask one API for its model IDs, then use `generate_image` even when their chat model has no built-in image generation. A model list may contain chat models too, so use a model your API documents for images. If the API does not list models, give the agent its image model ID. If the agent has deferred tools, it can find them by searching for “image generation”. API keys remain on the server.

Each request generates one image. You can specify a supported size and quality. Results are saved as PNG, JPEG or WebP files that the agent can show or link in the conversation. A failed request reports the error and does not switch to another API. Image generation may incur your API provider's normal charge.
