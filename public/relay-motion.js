"use strict";

(() => {
  if (document.body && document.body.classList.contains("product-page")) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scrollProgress = document.createElement("div");
  scrollProgress.className = "scroll-progress";
  scrollProgress.setAttribute("aria-hidden", "true");
  document.body.prepend(scrollProgress);

  const refreshButton = document.querySelector("#refresh-button");
  const refreshIcon = refreshButton?.querySelector("svg");
  if (refreshIcon) {
    refreshButton.addEventListener("click", () => {
      refreshIcon.animate(
        [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
        { duration: 650, easing: "cubic-bezier(.2,.75,.25,1)" }
      );
    });
  }

  let scrollFrame = 0;
  const updateScrollProgress = () => {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(() => {
      const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight;
      const progress = scrollableHeight > 0 ? window.scrollY / scrollableHeight : 0;
      const normalizedProgress = Math.min(1, Math.max(0, progress));
      scrollProgress.style.transform = `scaleX(${normalizedProgress})`;
      document.documentElement.style.setProperty("--scroll-progress", normalizedProgress);
      scrollFrame = 0;
    });
  };

  window.addEventListener("scroll", updateScrollProgress, { passive: true });
  window.addEventListener("resize", updateScrollProgress);
  updateScrollProgress();

  if (reducedMotion) return;

  const nav = document.querySelector(".topbar, .nav-wrap");
  let navFrame = 0;
  const updateNav = () => {
    if (!nav || navFrame) return;
    navFrame = window.requestAnimationFrame(() => {
      nav.classList.toggle("is-scrolled", window.scrollY > 14);
      navFrame = 0;
    });
  };
  window.addEventListener("scroll", updateNav, { passive: true });
  updateNav();

  document.querySelectorAll(".hero, .page-hero, .dashboard-heading, .auth-screen, .welcome-card").forEach((target) => {
    target.addEventListener("pointermove", (event) => {
      const bounds = target.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width) * 100;
      const y = ((event.clientY - bounds.top) / bounds.height) * 100;
      target.style.setProperty("--spotlight-x", `${x}%`);
      target.style.setProperty("--spotlight-y", `${y}%`);
    }, { passive: true });
    target.addEventListener("pointerleave", () => {
      target.style.removeProperty("--spotlight-x");
      target.style.removeProperty("--spotlight-y");
    }, { passive: true });
  });

  const pointerBound = new WeakSet();
  const bindPointerEffects = () => {
    document.querySelectorAll(".card, .offer, .form-card, .preview, .summary-card, .panel, .welcome-card, .metric, .auth-card, .template-card, .step-card").forEach((target) => {
      if (pointerBound.has(target)) return;
      pointerBound.add(target);
      target.addEventListener("pointermove", (event) => {
        const bounds = target.getBoundingClientRect();
        const x = event.clientX - bounds.left;
        const y = event.clientY - bounds.top;
        target.style.setProperty("--pointer-x", `${x}px`);
        target.style.setProperty("--pointer-y", `${y}px`);
      }, { passive: true });
      target.addEventListener("pointerleave", () => {
        target.style.removeProperty("--pointer-x");
        target.style.removeProperty("--pointer-y");
      }, { passive: true });
    });

  };
  bindPointerEffects();

  window.relayRefreshMotion = bindPointerEffects;
  if (!("IntersectionObserver" in window)) return;

  const targetSelector = [
    ".hero-copy > *",
    ".preview",
    ".page-hero .wrap",
    ".section-head",
    ".cards > *",
    ".steps > *",
    ".content-grid > *",
    ".form-layout > *",
    ".callout",
    ".price-note",
    ".form-card",
    ".foot-inner",
    ".dashboard-heading",
    ".summary-card",
    ".content-card",
    ".topbar",
    ".panel",
    ".welcome-card",
    ".metric",
    ".auth-card",
    ".template-card",
    ".step-card",
    ".section-intro",
    ".customer-privacy",
    ".list-row",
    ".info-row",
    ".data-table tbody tr"
  ].join(",");

  const observedTargets = new WeakSet();
  let revealIndex = 0;
  const observer = new IntersectionObserver((entries, currentObserver) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      currentObserver.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -36px 0px" });

  const refreshMotionTargets = () => {
    bindPointerEffects();
    const targets = document.querySelectorAll(targetSelector);
    if (targets.length) document.documentElement.classList.add("motion-ready");
    targets.forEach((target) => {
      if (observedTargets.has(target)) return;
      observedTargets.add(target);
      target.classList.add("motion-reveal");
      target.style.setProperty("--reveal-delay", `${(revealIndex++ % 3) * 90}ms`);
      observer.observe(target);
    });
  };

  window.relayRefreshMotion = refreshMotionTargets;
  refreshMotionTargets();
})();
