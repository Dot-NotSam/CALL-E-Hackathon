import { getRun, subscribe } from "@/lib/mock/store";
import { getOrderEvents } from "@/lib/db/orders-repository";
import type { SentinelEvent } from "@/lib/contracts/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/orders/:id/stream — Server-Sent Events carrying the
 * `SentinelEvent` union (docs/FRONTEND_BACKEND_CONTRACT.md §5).
 *
 * Events already emitted are replayed first upon client connection.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const run = getRun(id);
  const pastEvents = await getOrderEvents(id);

  if (!run && pastEvents.length === 0) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: SentinelEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const comment = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ${text}\n\n`));
        } catch {
          closed = true;
        }
      };

      comment("stream open");

      // Replay all past events
      const eventsToReplay = pastEvents.length > 0 ? pastEvents : run ? run.emitted : [];
      eventsToReplay.forEach(send);

      const unsubscribe = run ? subscribe(run, send) : () => {};

      // Keep-alive pings every 15 seconds
      const heartbeat = setInterval(() => comment("keep-alive"), 15_000);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed by the client */
        }
      };

      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
