/** Install the company URL adapter. Local desktop has no adapter and keeps loopback URLs. */
export function installPreviewClient({ previewHost, scope }) {
  // The released Browser sandbox omits downloads. Grant only our exact HTTPS preview origin.
  // Reattach the same element: changing sandbox during its first navigation can retain old flags.
  const granted = new WeakSet();
  const updateFrame = (frame) => {
    const sandbox = frame.getAttribute("sandbox");
    if (sandbox === null) { granted.delete(frame); return; }
    const tokens = new Set(sandbox.split(/\s+/).filter(Boolean));
    let preview = false;
    try { preview = new URL(frame.src).origin === `https://${previewHost}`; } catch (error) { /* No URL yet. */ }
    if (preview && !tokens.has("allow-downloads")) {
      tokens.add("allow-downloads"); granted.add(frame);
    } else if (!preview && granted.has(frame)) {
      tokens.delete("allow-downloads"); granted.delete(frame);
    } else return;
    const parent = frame.parentNode, next = frame.nextSibling;
    frame.remove();
    frame.setAttribute("sandbox", [...tokens].join(" "));
    parent.insertBefore(frame, next);
  };
  const observer = new MutationObserver((records) => {
    const frames = new Set();
    for (const record of records) {
      if (record.type === "attributes") frames.add(record.target);
      else for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches("iframe")) frames.add(node);
        for (const frame of node.querySelectorAll("iframe")) frames.add(frame);
      }
    }
    for (const frame of frames) if (frame.isConnected && frame.matches("iframe")) updateFrame(frame);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "sandbox"] });
  for (const frame of document.querySelectorAll("iframe")) updateFrame(frame);
  document.addEventListener("zp-preview-url", (event) => {
    const detail = event.detail;
    let url;
    try { url = new URL(detail.url); } catch (error) { return; }
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password) return;
    const port = Number(url.port || 80);
    // The gateway independently checks all ports; reserved ports must visibly fail there.
    const target = new URL(`https://${previewHost}/_wp_preview/start`);
    target.searchParams.set("owner", scope);
    target.searchParams.set("port", String(port));
    target.searchParams.set("path", url.pathname + url.search + url.hash);
    detail.url = target.href;
  });
}
