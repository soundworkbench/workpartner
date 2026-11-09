/* Original neutral geometric mark. */
(() => {
  const version = new URL(document.currentScript.src).search;
  class Mark {
    constructor(host, options) {
      this.host = host;
      host.classList.add('wp-neutral-mark');
      this.mark = document.createElement('img');
      this.mark.className = 'zp-pet';
      this.mark.src = '/favicon.svg' + version;
      this.mark.alt = '';
      this.mark.width = this.mark.height = options.size;
      host.appendChild(this.mark);
    }
    set(state) { this.state = state; this.mark.dataset.state = state; }
    wake() { this.set('idle'); }
    follow() {}
    nod() {}
    destroy() { this.host.remove(); }
  }
  window.ZpPet = Mark;
})();
