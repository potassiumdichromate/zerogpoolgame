/**
 * ZeroGPool WebGL
 *
 * Chrome ORB blocks cross-origin <script src>. We fetch bytes with fetch() → Blob URLs.
 *
 * Build artifacts: same origin as this page (`/zeroGpool-play/<file>` from public/).
 * StreamingAssets: `./StreamingAssets/` under the same folder (ship files in public/zeroGpool-play/StreamingAssets/).
 *
 * Manifest: ./manifest.json — relative_path must match files next to this HTML.
 */

/** Directory URL for this shell (trailing slash), e.g. …/zeroGpool-play/ */
function shellDirUrl() {
  return new URL(".", window.location.href).href;
}

function artifactUrl(relativePath) {
  return new URL(String(relativePath || "").replace(/^\/+/, ""), shellDirUrl()).href;
}

/** Folder URL for Unity StreamingAssets (must be absolute when loader/data are blob: URLs). */
function normalizeStreamingBase(u) {
  if (!u || !String(u).trim()) return "";
  const s = String(u).trim().replace(/\/+$/, "");
  return `${s}/`;
}

function resolveStreamingAssetsBase(manifestData) {
  const fromManifest =
    (manifestData && manifestData.streaming_assets_base_url) ||
    (manifestData && manifestData.streamingAssetsBaseUrl);
  const fromMeta = readMeta("zgp-streaming-assets-base", "");
  const explicit =
    (typeof fromManifest === "string" && fromManifest.trim() !== ""
      ? fromManifest
      : null) ||
    (typeof fromMeta === "string" && fromMeta.trim() !== "" ? fromMeta : null);
  if (explicit) return normalizeStreamingBase(explicit);
  return normalizeStreamingBase(new URL("StreamingAssets/", shellDirUrl()).href);
}

function readMeta(name, fallback) {
  const el = document.querySelector(`meta[name="${name}"]`);
  const v = el && el.getAttribute("content");
  return v != null && String(v).trim() !== "" ? String(v).trim() : fallback;
}

function removeUnityScripts() {
  document.querySelectorAll("script[data-zgp-unity]").forEach((s) => s.remove());
}

function mimeForPath(relativePath) {
  const n = String(relativePath || "");
  if (n.endsWith(".wasm")) return "application/wasm";
  if (n.endsWith(".js")) return "application/javascript";
  return "application/octet-stream";
}

async function fetchManifest() {
  const res = await fetch("./manifest.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`manifest_http_${res.status}`);
  const j = await res.json();
  const files = Array.isArray(j.files) ? j.files : j;
  if (!Array.isArray(files) || files.length < 4) {
    throw new Error("manifest_bad_shape");
  }
  const streaming_assets_base_url =
    typeof j.streaming_assets_base_url === "string"
      ? j.streaming_assets_base_url
      : typeof j.streamingAssetsBaseUrl === "string"
        ? j.streamingAssetsBaseUrl
        : "";
  return { files, streaming_assets_base_url };
}

function pickUnityEntries(entries) {
  const loader = entries.find((f) =>
    String(f.relative_path || "").endsWith(".loader.js"),
  );
  const data = entries.find((f) =>
    String(f.relative_path || "").endsWith(".data"),
  );
  const fw = entries.find((f) =>
    String(f.relative_path || "").endsWith(".framework.js"),
  );
  const wasm = entries.find((f) =>
    String(f.relative_path || "").endsWith(".wasm"),
  );
  if (!loader || !data || !fw || !wasm || !loader.relative_path || !data.relative_path) {
    throw new Error("manifest_missing_unity_artifacts");
  }
  return { loader, data, fw, wasm };
}

async function blobUrlFromResponse(res, relativePath) {
  const buf = await res.arrayBuffer();
  return URL.createObjectURL(
    new Blob([buf], { type: mimeForPath(relativePath) }),
  );
}

/**
 * Fetch one artifact from the same origin as this page (static /zeroGpool-play/).
 */
async function fetchArtifactBlobUrl(entry) {
  const path = entry.relative_path;
  const url = artifactUrl(path);
  const res = await fetch(url, {
    mode: "same-origin",
    credentials: "omit",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`static_${res.status}`);
  const blobUrl = await blobUrlFromResponse(res, path);
  return { blobUrl, source: "same_origin_static", path };
}

/** Append wallet only for http(s) URLs; blob: URLs cannot carry query reliably */
function withWallet(u, wallet) {
  if (!wallet || String(u).startsWith("blob:")) return u;
  const sep = String(u).includes("?") ? "&" : "?";
  return `${u}${sep}wallet=${encodeURIComponent(wallet)}`;
}

/**
 * Prefetch all four → blob URLs, inject loader blob, run Unity.
 */
async function loadUnityFromBlobs(entries, canvas, statusEl, opts) {
  const wallet =
    new URLSearchParams(window.location.search).get("wallet") || "";
  const { loader, data, fw, wasm } = pickUnityEntries(entries);

  statusEl.textContent = "Downloading build (same origin)…";

  const results = await Promise.all([
    fetchArtifactBlobUrl(loader),
    fetchArtifactBlobUrl(data),
    fetchArtifactBlobUrl(fw),
    fetchArtifactBlobUrl(wasm),
  ]);

  const summary = {
    short: "Static files (same origin)",
    usedCloudflare: false,
    rows: results,
  };
  window.ZGP_ARTIFACT_SOURCES = results.map((r) => ({
    path: r.path,
    source: r.source,
  }));
  console.info("[ZeroGPool] Build artifact sources:", window.ZGP_ARTIFACT_SOURCES);
  console.info("[ZeroGPool] Summary:", summary.short);

  const loaderBlob = results[0].blobUrl;
  const dataBlob = results[1].blobUrl;
  const fwBlob = results[2].blobUrl;
  const wasmBlob = results[3].blobUrl;

  const dbg =
    new URLSearchParams(window.location.search).get("debug") === "1";
  if (dbg) {
    console.table(window.ZGP_ARTIFACT_SOURCES);
  }

  statusEl.textContent = `Bytes loaded — ${summary.short}`;

  return new Promise((resolve, reject) => {
    removeUnityScripts();
    const script = document.createElement("script");
    script.async = true;
    script.dataset.zgpUnity = "1";
    script.src = loaderBlob;
    script.onload = async () => {
      try {
        if (typeof createUnityInstance !== "function") {
          throw new Error("createUnityInstance_missing");
        }
        const streamingUrl =
          opts.streamingAssetsBase && String(opts.streamingAssetsBase).trim()
            ? String(opts.streamingAssetsBase).trim()
            : "StreamingAssets";
        if (
          String(dataBlob).startsWith("blob:") &&
          streamingUrl === "StreamingAssets"
        ) {
          console.warn(
            "[ZeroGPool] Core build uses blob: URLs; set manifest.streaming_assets_base_url or meta zgp-streaming-assets-base to an absolute StreamingAssets/ folder URL.",
          );
        }
        const config = {
          arguments: [],
          dataUrl: withWallet(dataBlob, wallet),
          frameworkUrl: withWallet(fwBlob, wallet),
          codeUrl: withWallet(wasmBlob, wallet),
          streamingAssetsUrl: streamingUrl,
          companyName: "Kult Games",
          productName: "ZeroGPool",
          productVersion: "8",
        };
        statusEl.textContent = "Unity starting…";
        const instance = await createUnityInstance(canvas, config, (p) => {
          statusEl.textContent = `Loading… ${Math.round(p * 100)}%`;
        });
        window.ZGP_LAST_LOAD_SUMMARY = summary;
        resolve(instance);
      } catch (e) {
        reject(e);
      }
    };
    script.onerror = () => reject(new Error("unity_loader_exec_failed"));
    document.body.appendChild(script);
  });
}

async function main() {
  const statusEl = document.getElementById("status");
  const canvas = document.getElementById("unity-canvas");

  let manifestData;
  try {
    manifestData = await fetchManifest();
  } catch (e) {
    console.error(e);
    statusEl.textContent = `Failed: manifest.json (${e && e.message ? e.message : e})`;
    return;
  }

  const entries = manifestData.files;
  const streamingAssetsBase = resolveStreamingAssetsBase(manifestData);

  const baseOpts = {
    streamingAssetsBase,
  };

  try {
    statusEl.textContent = "Loading build from server…";
    await loadUnityFromBlobs(entries, canvas, statusEl, baseOpts);
    statusEl.textContent = `Ready — ${window.ZGP_LAST_LOAD_SUMMARY?.short || "OK"}`;
  } catch (e) {
    console.error(e);
    statusEl.textContent = `Failed: ${e && e.message ? e.message : e}`;
  }
}

main();
