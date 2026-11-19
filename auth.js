// Supabase authentication and the signed-in user's cloud workspace.
window.AttendEaseAuth = (function () {
  const config = window.ATTENDEASE_SUPABASE_CONFIG;
  const el = (id) => document.getElementById(id);
  let client = null;
  let user = null;
  let onReady = null;
  let startingSession = false;

  if (window.supabase && config && config.url && config.anonKey) {
    client = window.supabase.createClient(config.url, config.anonKey);
  }

  function currentUser() {
    return user;
  }

  function showError(message) {
    el("authError").textContent = message;
  }

  function authErrorMessage(error) {
    const message = error && typeof error.message === "string" ? error.message : "";
    if (error && (error.code === "invalid_credentials" || /invalid login credentials/i.test(message))) {
      return "Incorrect email or password.";
    }
    if (error && (error.name === "AuthRetryableFetchError" || error.name === "FetchError" ||
        error instanceof TypeError || /failed to fetch|fetch failed|load failed|network error|network request failed|internet disconnected/i.test(message))) {
      return "Network error. Check your internet connection and try again.";
    }
    if (error && Number(error.status) >= 500) {
      return "The login service is temporarily unavailable. Please try again shortly.";
    }
    return message || "Something went wrong. Please try again.";
  }

  function showTab(name) {
    const login = name === "login";
    const form = el(login ? "loginForm" : "signupForm");
    const changed = form.hidden;
    el("loginForm").hidden = !login;
    el("signupForm").hidden = login;
    el("tabLogin").setAttribute("aria-selected", String(login));
    el("tabSignup").setAttribute("aria-selected", String(!login));
    showError("");
    if (changed) {
      form.classList.remove("auth-form-entering");
      void form.offsetWidth;
      form.classList.add("auth-form-entering");
    }
  }

  function setProfile(authUser) {
    const name = authUser.user_metadata && authUser.user_metadata.full_name ||
      authUser.email.split("@")[0];
    user = {
      id: authUser.id,
      name,
      email: authUser.email,
      metadata: authUser.user_metadata || {}
    };
  }

  function showWorkspaceWithTransition() {
    const authScreen = el("authScreen");
    const app = document.querySelector(".app-layout");
    const animate = !authScreen.hidden &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    app.hidden = false;
    if (!animate) {
      authScreen.hidden = true;
      return;
    }

    const mark = document.createElement("div");
    mark.className = "transition-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = '<svg viewBox="0 0 64 64" focusable="false"><circle cx="32" cy="32" r="26"></circle><path d="m19 32 9 9 18-19"></path></svg>';
    document.body.append(mark);
    authScreen.classList.add("auth-leaving");
    app.classList.add("app-entering");

    let exitTimer;
    const hideAuth = (event) => {
      if (event && event.target !== authScreen) return;
      window.clearTimeout(exitTimer);
      authScreen.hidden = true;
      authScreen.classList.remove("auth-leaving");
      authScreen.removeEventListener("animationend", hideAuth);
    };
    authScreen.addEventListener("animationend", hideAuth);
    exitTimer = window.setTimeout(() => hideAuth(), 550);

    let transitionTimer;
    const finishTransition = (event) => {
      if (event && event.target !== mark) return;
      window.clearTimeout(transitionTimer);
      mark.removeEventListener("animationend", finishTransition);
      mark.remove();
      app.classList.remove("app-entering");
    };
    mark.addEventListener("animationend", finishTransition);
    transitionTimer = window.setTimeout(() => finishTransition(), 800);
  }

  async function startSession(authUser) {
    if (startingSession || user) return;
    startingSession = true;
    setProfile(authUser);
    try {
      await onReady();
      showWorkspaceWithTransition();
    } catch (error) {
      user = null;
      document.querySelector(".app-layout").hidden = true;
      el("authScreen").hidden = false;
      showError("Signed in, but the cloud workspace could not be loaded: " + authErrorMessage(error));
    } finally {
      startingSession = false;
    }
  }

  async function loadWorkspace() {
    if (!client || !user) throw new Error("Supabase is not connected.");
    const { data, error } = await client
      .from("attendease_workspaces")
      .select("workspace")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw error;
    return data ? data.workspace : null;
  }

  async function saveWorkspace(workspace) {
    if (!client || !user) throw new Error("Supabase is not connected.");
    const { error } = await client.from("attendease_workspaces").upsert({
      user_id: user.id,
      workspace,
      updated_at: new Date().toISOString()
    });
    if (error) throw error;
  }

  async function handleLogin(event) {
    event.preventDefault();
    const email = el("loginEmail").value.trim().toLowerCase();
    const password = el("loginPassword").value;
    if (!email || !password) return showError("Enter your email and password.");
    showError("");
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) return showError(authErrorMessage(error));
    if (!data.user) return showError("Supabase did not return a user. Please try again.");
    await startSession(data.user);
  }

  async function handleSignup(event) {
    event.preventDefault();
    const name = el("signupName").value.trim().replace(/\s+/g, " ");
    const email = el("signupEmail").value.trim().toLowerCase();
    const password = el("signupPassword").value;
    if (!name) return showError("Enter your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError("Enter a valid email address.");
    if (password.length < 8) return showError("Use a password with at least 8 characters.");
    if (password !== el("signupConfirm").value) return showError("The two passwords do not match.");
    showError("");
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: name,
          start_with_sample: el("signupSample").checked
        },
        emailRedirectTo: window.location.href
      }
    });
    if (error) return showError(error.message);
    if (data.session && data.user) {
      await startSession(data.user);
    } else {
      showTab("login");
      showError("Account created. Check your email to confirm the account, then log in.");
    }
  }

  async function logout() {
    const { error } = await client.auth.signOut();
    if (error) throw error;
    location.reload();
  }

  function show(callback) {
    onReady = callback;
    document.querySelector(".app-layout").hidden = true;
    el("authScreen").hidden = false;
    el("tabLogin").addEventListener("click", () => showTab("login"));
    el("tabSignup").addEventListener("click", () => showTab("signup"));
    el("loginForm").addEventListener("submit", (event) => {
      handleLogin(event).catch((error) => showError(authErrorMessage(error)));
    });
    el("signupForm").addEventListener("submit", (event) => {
      handleSignup(event).catch((error) => showError(authErrorMessage(error)));
    });
    document.querySelectorAll("[data-target]").forEach((button) => {
      button.addEventListener("click", () => {
        const input = el(button.dataset.target);
        const visible = input.type === "password";
        input.type = visible ? "text" : "password";
        button.textContent = visible ? "Hide" : "Show";
        button.setAttribute("aria-pressed", String(visible));
      });
    });

    if (!client) {
      showError("Supabase is not configured. Set the project URL and publishable key in supabase-config.js.");
      document.querySelectorAll("#loginForm input, #loginForm button, #signupForm input, #signupForm button")
        .forEach((control) => { control.disabled = true; });
      return;
    }

    client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" && user) location.reload();
      if (event === "SIGNED_IN" && session && !user) {
        window.setTimeout(() => startSession(session.user), 0);
      }
    });
    client.auth.getSession().then(({ data, error }) => {
      if (error) throw error;
      if (data.session) return startSession(data.session.user);
    }).catch((error) => showError("Could not check the Supabase session: " + authErrorMessage(error)));
  }

  return { show, currentUser, loadWorkspace, saveWorkspace, logout };
})();
git ad