import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { addStaleCacheClearHeaders } from "./utils/staleCache.server";
import { startWebhookRetryLoop, stopWebhookRetryLoop } from "./models/webhookQueue.server";
import { failInterruptedSyncLogs } from "./models/syncJobs.server";
import { installShutdownHandlers } from "./utils/gracefulShutdown.server";

// Replays failed webhook deliveries in the background (see webhookQueue.server.js).
startWebhookRetryLoop();
// Make a plain `kill` actually stop the process (see gracefulShutdown.server.js).
if (!globalThis.__zohoShutdownHandlersInstalled) {
  globalThis.__zohoShutdownHandlersInstalled = true;
  installShutdownHandlers({ stopBackgroundWork: stopWebhookRetryLoop });
}
// Sync runs left "running" by a previous process can never finish now.
if (!globalThis.__zohoSyncLogsRecovered) {
  globalThis.__zohoSyncLogsRecovered = true;
  failInterruptedSyncLogs().catch((error) => console.error("Failed to recover interrupted sync logs", error));
}

export const streamTimeout = 5000;

export default async function handleRequest(
  request,
  responseStatusCode,
  responseHeaders,
  reactRouterContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  addStaleCacheClearHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
