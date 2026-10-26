"use strict";

const menuToggle = document.querySelector(".menu-toggle");
const menuPanel = document.getElementById("site-menu");

if (menuToggle && menuPanel) {
  const mobileNavigation = window.matchMedia("(max-width: 980px)");
  const setMobileState = () => {
    menuPanel.classList.remove("is-open");
    menuPanel.inert = mobileNavigation.matches;
    menuToggle.setAttribute("aria-expanded", "false");
    menuToggle.setAttribute("aria-label", "Open menu");
  };

  const closeMenu = () => {
    menuPanel.classList.remove("is-open");
    menuPanel.inert = mobileNavigation.matches;
    menuToggle.setAttribute("aria-expanded", "false");
    menuToggle.setAttribute("aria-label", "Open menu");
  };

  setMobileState();
  mobileNavigation.addEventListener("change", setMobileState);

  menuToggle.addEventListener("click", () => {
    const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
    if (!mobileNavigation.matches) return;
    menuPanel.classList.toggle("is-open", !isOpen);
    menuPanel.inert = isOpen;
    menuToggle.setAttribute("aria-expanded", String(!isOpen));
    menuToggle.setAttribute("aria-label", isOpen ? "Open menu" : "Close menu");
  });

  menuPanel.addEventListener("click", (event) => {
    if (mobileNavigation.matches && event.target instanceof HTMLAnchorElement) closeMenu();
  });

  document.addEventListener("click", (event) => {
    if (mobileNavigation.matches && menuPanel.classList.contains("is-open") && !menuPanel.contains(event.target) && !menuToggle.contains(event.target)) {
      closeMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mobileNavigation.matches && menuPanel.classList.contains("is-open")) {
      closeMenu();
      menuToggle.focus();
    }
  });
}
