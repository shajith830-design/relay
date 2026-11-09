"use strict";

document.querySelectorAll("#inquiry-form").forEach((form) => {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const data = new FormData(form);
    const status = document.getElementById("form-status");
    const button = form.querySelector('button[type="submit"]');
    const originalText = button.textContent;

    if (window.location.protocol === "file:") {
      status.classList.add("error");
      status.textContent = "This form needs the hosted Relay website. Opening a local HTML file cannot submit inquiries.";
      return;
    }

    button.disabled = true;
    button.textContent = "Sending...";
    status.className = "form-status";
    status.textContent = "Sending your inquiry...";

    try {
      const response = await fetch("/api/inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          company: data.get("company"),
          email: data.get("email"),
          phone: data.get("phone"),
          message: data.get("details"),
          inquiryType: form.dataset.inquiryType || "Contact inquiry"
        })
      });
      let result;
      try {
        result = await response.json();
      } catch {
        throw new Error("The server returned an invalid response. Please try again.");
      }
      if (!response.ok || !result.success) {
        throw new Error(result.error || "Unable to submit your inquiry. Please try again.");
      }

      status.classList.add("success");
      status.textContent = "Thanks. Your message was received.";
      form.reset();
    } catch (error) {
      status.classList.add("error");
      status.textContent = error.message || "Unable to submit your inquiry. Please try again.";
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });
});
