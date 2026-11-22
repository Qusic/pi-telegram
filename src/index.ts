// Pi reloads the extension on session swaps, so these managers are session-scoped.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createApi } from "./api.ts";
import { createAttach } from "./attach.ts";
import { createConfig } from "./config.ts";
import { createDispatcher } from "./dispatch.ts";
import { createPolling } from "./polling.ts";
import { createTurn } from "./turn.ts";

export default async function (pi: ExtensionAPI) {
	const config = await createConfig();
	const api = createApi(config);
	const turn = createTurn({ pi, api });
	const dispatch = createDispatcher({ pi, api, turn });
	createPolling({ pi, api, config, dispatch });
	createAttach({ pi, api, config });
}
