// Entry point. Pi reloads extensions on every session swap, so each module
// returns a manager closure that owns its own state and event handlers.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createApi } from "./api.ts";
import { createConfig } from "./config.ts";
import { createDispatcher } from "./dispatch.ts";
import { createMedia } from "./media.ts";
import { createPolling } from "./polling.ts";
import { createPreview } from "./preview.ts";
import { createTurn } from "./turn.ts";

export default async function (pi: ExtensionAPI) {
	const config = await createConfig();
	const api = createApi(config);
	const preview = createPreview(api);
	const media = createMedia(api);
	const turn = createTurn({ pi, api, media, preview });
	const dispatch = createDispatcher({ pi, api, turn });
	createPolling({ pi, api, config, dispatch });
}
