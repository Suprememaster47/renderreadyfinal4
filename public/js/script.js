// ===== WebSocket Chat =====
(() => {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const WS_URL = `${protocol}://${location.host}/ws`;
  const ws = new WebSocket(WS_URL);

  const messages = document.getElementById("chat-messages");
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send");

  const sessionId = localStorage.getItem("chat_session_id") || `s_${Date.now().toString(36)}`;
  localStorage.setItem("chat_session_id", sessionId);

  let isSending = false;

  function addBubble(text, who, options = {}) {
    const div = document.createElement("div");
    div.className = `msg ${who}`;
    if (who === "bot" && options.isTyping) {
      const t = document.createElement("div");
      t.className = "typing";
      t.innerHTML = '<span></span><span></span><span></span>';
      div.appendChild(t);
    } else {
      div.textContent = text;
    }
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  function setSendingState(sending) {
    isSending = sending;
    sendBtn.disabled = sending;
  }

  ws.addEventListener("open", () => addBubble("Connected to server", "bot"));
  ws.addEventListener("message", (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      if (payload.error) {
        addBubble(payload.error, "bot");
        setSendingState(false);
        return;
      }
      if (payload.reply) {
        const last = messages.lastElementChild;
        if (last && last.querySelector && last.querySelector(".typing")) messages.removeChild(last);
        addBubble(payload.reply, "bot");
      }
    } catch (e) {
      console.warn("Invalid WS message", ev.data);
    } finally {
      setSendingState(false);
    }
  });
  ws.addEventListener("close", () => addBubble("Connection closed.", "bot"));
  ws.addEventListener("error", (e) => console.error("WS error", e));

  function sendMessage() {
    const text = input.value.trim();
    if (!text || isSending || ws.readyState !== WebSocket.OPEN) return;
    addBubble(text, "user");
    input.value = "";
    addBubble("", "bot", { isTyping: true });
    setSendingState(true);
    ws.send(JSON.stringify({ message: text, sessionId }));
  }

  sendBtn.addEventListener("click", sendMessage);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") sendMessage(); });
})();

// ===== Reviews & reCAPTCHA =====
document.addEventListener("DOMContentLoaded", () => {
  const reviewsList = document.getElementById("reviewsList");
  const reviewFormWrap = document.getElementById("reviewFormWrap");
  const toggleReviewBtn = document.getElementById("toggleReviewBtn");
  const reviewForm = document.getElementById("reviewForm");
  const starsInput = document.getElementById("starsInput");
  const reviewSubmitting = document.getElementById("reviewSubmitting");
  const recaptchaContainer = document.getElementById("recaptcha-container");
  const avgStarsEl = document.getElementById("avgStarsText1");
  const totalReviewsEl = document.getElementById("totalReviews");
  const avgStarsVisual = document.querySelectorAll(".star1");

  let recaptchaWidgetId = null;
  let currentPage = 1;
  const limit = 5;

  // reCAPTCHA explicit render
  window.onRecaptchaLoad = async function () {
    try {
      const res = await fetch("/recaptcha-site-key");
      const data = await res.json();
      if (!data.site_key) return console.warn("No recaptcha site key returned");
      if (typeof grecaptcha !== "undefined" && recaptchaContainer) {
        recaptchaWidgetId = grecaptcha.render(recaptchaContainer, { sitekey: data.site_key });
      }
    } catch (err) { console.error("Failed to fetch recaptcha key", err); }
  };

  // Toggle review form
  toggleReviewBtn.addEventListener("click", () => {
    reviewFormWrap.style.maxHeight = reviewFormWrap.style.maxHeight ? null : reviewFormWrap.scrollHeight + "px";
  });

  // Star selection
  document.querySelectorAll(".star").forEach((s) => {
    s.addEventListener("click", () => {
      const val = parseInt(s.dataset.value, 10);
      starsInput.value = val;
      document.querySelectorAll(".star").forEach((st) => st.classList.toggle("active", parseInt(st.dataset.value, 10) <= val));
    });
  });

  // Load reviews + stats
  async function loadReviews(page = 1) {
    try {
      // Fetch paginated reviews
      const res = await fetch(`/api/reviews?page=${page}&limit=${limit}`);
      const data = await res.json();
      reviewsList.innerHTML = "";
      (data.reviews || []).forEach((r) => {
        const d = document.createElement("div");
        d.className = "review-item";
        const when = new Date(r.createdAt).toLocaleString();
        d.innerHTML = `<strong>${r.name || "anon"}</strong> • ${r.stars}★ • <small>${when}</small><div>${r.review_text}</div>`;
        reviewsList.appendChild(d);
      });

      // Update stats
      const statsRes = await fetch("/api/stats");
      const stats = await statsRes.json();
      avgStarsEl.textContent = (stats.avgStars || 0).toFixed(1);
      totalReviewsEl.textContent = stats.totalReviews || 0;

      // Visual stars for average rating
      avgStarsVisual.forEach((st) => {
        const val = parseInt(st.dataset.value, 10);
        st.classList.remove("active1");
        st.style.background = "";
        if (val <= Math.floor(stats.avgStars)) st.classList.add("active1");
        else if (val - stats.avgStars < 1 && val > stats.avgStars) {
          st.style.background = `linear-gradient(90deg, #f1c40f ${(stats.avgStars - Math.floor(stats.avgStars)) * 100}%, #bbb ${(stats.avgStars - Math.floor(stats.avgStars)) * 100}%)`;
          st.style.webkitBackgroundClip = "text";
          st.style.webkitTextFillColor = "transparent";
        }
      });

      // Enable/disable next/prev buttons if needed
      const prevBtn = document.getElementById("prevBtn");
      const nextBtn = document.getElementById("nextBtn");
      if (prevBtn && nextBtn) {
        prevBtn.disabled = page <= 1;
        nextBtn.disabled = page >= data.total_pages;
        prevBtn.onclick = () => { if (currentPage > 1) { currentPage--; loadReviews(currentPage); } };
        nextBtn.onclick = () => { if (currentPage < data.total_pages) { currentPage++; loadReviews(currentPage); } };
      }
    } catch (err) {
      console.error("loadReviews error", err);
    }
  }

  // Submit review
  reviewForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    reviewSubmitting.classList.remove("hidden");

    let recaptchaToken = "";
    if (typeof grecaptcha !== "undefined" && recaptchaWidgetId !== null) {
      recaptchaToken = grecaptcha.getResponse(recaptchaWidgetId);
    }
    if (!recaptchaToken) { reviewSubmitting.classList.add("hidden"); return alert("Complete CAPTCHA"); }

    const data = Object.fromEntries(new FormData(reviewForm).entries());
    data.recaptcha_token = recaptchaToken;

    try {
      const resp = await fetch("/api/submit_review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      const resJson = await resp.json();
      reviewSubmitting.classList.add("hidden");
      if (!resJson.success) { if (typeof grecaptcha !== "undefined" && recaptchaWidgetId !== null) grecaptcha.reset(recaptchaWidgetId); return alert(resJson.message || "Failed"); }

      reviewForm.reset();
      if (typeof grecaptcha !== "undefined" && recaptchaWidgetId !== null) grecaptcha.reset(recaptchaWidgetId);
      document.querySelectorAll(".star").forEach(st => st.classList.remove("active"));
      reviewFormWrap.style.maxHeight = null;
      await loadReviews(currentPage);
    } catch (err) {
      console.error("submit error", err);
      reviewSubmitting.classList.add("hidden");
      if (typeof grecaptcha !== "undefined" && recaptchaWidgetId !== null) grecaptcha.reset(recaptchaWidgetId);
      alert("Network error while submitting");
    }
  });

  loadReviews(currentPage);
});
