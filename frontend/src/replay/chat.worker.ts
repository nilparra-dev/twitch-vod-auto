import { readWindow, searchArchive, type ArchiveIndex } from "./archive";
import { createIndexedDbCache, loadArchive, type IndexCache } from "./index-cache";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { createRemoteFile } from "./remote-file";

let archive: ArchiveIndex | null = null;
let cache: IndexCache | null = null;
let searchId = 0;
const send = (message: WorkerResponse) => self.postMessage(message);

const indexCache = (): IndexCache => (cache ??= createIndexedDbCache());

self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    switch (data.kind) {
      case "loadRemote": {
        const target = new URL(data.url, self.location.href);
        if (target.origin !== self.location.origin)
          throw new Error("Chat must be served by the local player.");
        const file = createRemoteFile({ url: target, size: data.size });
        archive = await loadArchive(
          file,
          `remote:${target.href}:${data.size}`,
          (percent) => send({ kind: "progress", percent }),
          indexCache(),
        );
        send({ kind: "ready", info: archive.info });
        break;
      }
      case "load":
        archive = await loadArchive(
          data.file,
          `local:${data.file.name}:${data.file.size}:${data.file.lastModified}`,
          (percent) => send({ kind: "progress", percent }),
          indexCache(),
        );
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
