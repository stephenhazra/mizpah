(() => {
  const SKIP_SELECTORS = [".ytp-ad-skip-button", ".ytp-ad-skip-button-modern", ".ytp-skip-ad-button", "button[id^='skip-button']", ".ytp-ad-overlay-close-button"];

  const skip = (player) => {
    for (const sel of SKIP_SELECTORS) player.querySelector(sel)?.click();
    if (!player.classList.contains("ad-showing")) return;
    const video = player.querySelector("video");
    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      video.muted = true;
      video.playbackRate = 16;
      video.currentTime = video.duration - 0.1;
    }
  };

  let watched = null;
  const watch = (player) => {
    if (player === watched) return;
    watched = player;
    let frame = 0;
    new MutationObserver(() => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        skip(player);
      });
    }).observe(player, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    skip(player);
  };

  const find = () => {
    const player = document.querySelector("#movie_player");
    if (player) watch(player);
  };
  let pending = 0;
  new MutationObserver(() => {
    pending ||= requestAnimationFrame(() => {
      pending = 0;
      find();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  find();
})();
