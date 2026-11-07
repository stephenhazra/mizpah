(() => {
  const SKIP_SELECTORS = [
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-skip-ad-button",
    "button[id^='skip-button']",
    ".ytp-ad-overlay-close-button"
  ];

  const handle = () => {
    const player = document.querySelector("#movie_player");
    if (!player) return;
    for (const sel of SKIP_SELECTORS) document.querySelector(sel)?.click();
    if (!player.classList.contains("ad-showing")) return;
    const video = player.querySelector("video");
    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      video.muted = true;
      video.playbackRate = 16;
      video.currentTime = video.duration - 0.1;
    }
  };

  new MutationObserver(handle).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class"]
  });
  handle();
})();
