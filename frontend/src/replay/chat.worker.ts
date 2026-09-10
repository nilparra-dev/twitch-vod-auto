import { indexArchive, readWindow, searchArchive, type ArchiveIndex } from "./archive";
import type { WorkerRequest, WorkerResponse } from "./protocol";

let archive: ArchiveIndex | null = null;
let searchId = 0;
const send = (message: WorkerResponse) => self.postMessage(message);
self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    switch (data.kind) {
      case "loadRemote": {
        const target = new URL(data.url, self.location.href);
        if (target.origin !== self.location.origin)
          throw new Error("Chat must be served by the local player.");
        archive = await indexArchive(
          {
            size: data.size,
            slice: (start = 0, end = data.size) => ({
              arrayBuffer: async () => {
                if (start === end) return new ArrayBuffer(0);
                const response = await fetch(target, {
                  headers: { Range: `bytes=${start}-${Math.min(end, data.size) - 1}` },
                });
                if (
                  response.status !== 206 ||
                  response.headers.get("content-range") !==
                    `bytes ${start}-${Math.min(end, data.size) - 1}/${data.size}`
                )
                  throw new Error("The local chat file changed or is no longer available.");
                return response.arrayBuffer();
              },
            }),
          },
          (percent) => send({ kind: "progress", percent }),
        );
        send({ kind: "ready", info: archive.info });
        break;
      }
      case "load":
        archive = await indexArchive(data.file, (percent) => send({ kind: "progress", percent }));
        send({ kind: "ready", info: archive.info });
        break;
      case "window":
        if (archive)
          send({ kind: "window", id: data.id, messages: await readWindow(archive, data.time) });
        break;
      case "search": {
        searchId = data.id;
        if (!archive) break;
        const messages = await searchArchive(archive, data.query, () => searchId !== data.id);
        if (searchId === data.id) send({ kind: "search", id: data.id, messages });
        break;
      }
    }
  } catch (error) {
    send({
      kind: "error",
      message: error instanceof Error ? error.message : "Could not read the chat archive.",
    });
  }
};
