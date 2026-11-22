"use strict";

(() => {
  const search = new URLSearchParams(window.location.search);
  const demoMode = search.get("demo");
  if (demoMode === "workspace" || demoMode === "ray" || search.has("invite") || search.has("reset")) return;

  const publicKey = "pk_DG_Xs99WSKoO2bjcRhQ5IfsHgEXMUehm";
  const apiUrl = "https://api.justonecx.com";
  const disableChat = true;
  const script = document.createElement("script");
  script.src = "https://app.justonecx.com/sdk/justonecx-sdk.global.js";
  script.async = true;
  script.dataset.publicKey = publicKey;
  script.dataset.apiUrl = apiUrl;
  if (disableChat) script.dataset.disableChat = "true";

  const ready = new Promise((resolve, reject) => {
    script.addEventListener("load", () => {
      if (!window.JustOneCX) {
        reject(new Error("JustOneCX loaded without exposing its browser API."));
        return;
      }
      resolve(window.JustOneCX);
    }, { once: true });
    script.addEventListener("error", () => {
      reject(new Error("The JustOneCX SDK could not be loaded."));
    }, { once: true });
  });
  ready.catch((error) => console.warn("[Relay] JustOneCX SDK failed to load.", error));

  window.RelayJustOneCX = {
    async identify({ userId, userHash, userTraits, accountId, accountHash, accountTraits }) {
      if (!userHash || !accountHash) {
        throw new Error("Server-verified JustOneCX identity signatures are required.");
      }
      const sdk = await ready;
      await sdk.identify(String(userId), userTraits, { userHash });
      await sdk.group(String(accountId), accountTraits, { accountHash });
      await sdk.init({ publicKey, apiUrl, disableChat });
    },
    async reset() {
      const sdk = await ready;
      await sdk.reset();
    }
  };

  document.head.append(script);
})();
