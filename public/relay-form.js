"use strict";

document.querySelectorAll("#inquiry-form").forEach((form) => {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const data = new FormData(form);
    const status = document.getElementById("form-status");
    const button = form.querySelector('button[type="submit"]');
    const originalText = button.textContent;
    const message = [
      `Inquiry type: ${form.dataset.inquiryType || "Onboarding inquiry"}`,
      `Company: ${data.get("company")}`,
      `Work email: ${data.get("email")}`,
      `Details: ${data.get("details")}`
    ].join("\n");

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
          phone: data.get("phone"),
          message
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
