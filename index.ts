// Entry point. Pi reloads extensions on every session swap, so each module
// returns a manager closure that owns its own state and event handlers.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createApi } from "./api.js";
import { createConfig } from "./config.js";
import { createDispatcher } from "./dispatch.js";
import { createMedia } from "./media.js";
import { createPolling } from "./polling.js";
import { createPreview } from "./preview.js";
import { createTurn } from "./turn.js";

export default async function (pi: ExtensionAPI) {
	const config = await createConfig();
	const api = createApi(config);
	const preview = createPreview(api);
	const media = createMedia(api);
	const turn = createTurn({ pi, api, media, preview });
	const dispatch = createDispatcher({ pi, api, turn });
	createPolling({ pi, api, config, dispatch });
}
