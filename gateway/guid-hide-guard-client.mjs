/** Small emergency guard for an old overlay hiding the whole home composer. */
export function guidHideGuardClient() {
  return `\n;(${installGuidHideGuard.toString()})();`;
}

function installGuidHideGuard() {
  try {
    const reveal = node => {
      if (!node || node.nodeType !== 1) return;
      const containsInput = node.matches?.('[data-testid="guid-input"]') || node.querySelector('[data-testid="guid-input"]');
      if (node.classList.contains('wp-hide') && containsInput) node.classList.remove('wp-hide');
      node.querySelectorAll('.wp-hide').forEach(child => {
        if (child.matches?.('[data-testid="guid-input"]') || child.querySelector('[data-testid="guid-input"]')) child.classList.remove('wp-hide');
      });
    };
    const observer = new MutationObserver(records => {
      for (const record of records) {
        reveal(record.target);
        for (const node of record.addedNodes) reveal(node);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    reveal(document.documentElement);
  } catch { /* A page without the DOM APIs should keep loading normally. */ }
}
