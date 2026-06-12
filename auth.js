// SUPERCOACH — Supabase Auth Client
// Branche: feature/auth

const SUPABASE_URL = 'https://exezkqkyulzeslducsxi.supabase.co';
const SUPABASE_KEY = 'sb_publishable_LFbDRqlxiZ8bSLbfgQkaRA_06wGrtL3';

// Charger le SDK Supabase depuis CDN
async function loadSupabase() {
  if (window._supabase) return window._supabase;
  await new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
    s.onload = resolve;
    document.head.appendChild(s);
  });
  window._supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  return window._supabase;
}

// ── CONNEXION ──────────────────────────────────────────

// Magic Link (email sans mot de passe)
async function signInWithMagicLink(email) {
  const sb = await loadSupabase();
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin }
  });
  if (error) throw error;
  return true;
}

// Google OAuth
async function signInWithGoogle() {
  const sb = await loadSupabase();
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
  if (error) throw error;
}

// Déconnexion
async function signOut() {
  const sb = await loadSupabase();
  const { error } = await sb.auth.signOut();
  if (error) throw error;
  window._currentUser = null;
  updateAuthUI(null);
}

// ── SESSION ───────────────────────────────────────────

// Vérifier la session au chargement
async function initAuth() {
  const sb = await loadSupabase();

  // Écouter les changements d'état auth
  sb.auth.onAuthStateChange(async (event, session) => {
    if (session?.user) {
      const profile = await fetchProfile(session.user.id);
      window._currentUser = { ...session.user, profile };
      updateAuthUI(window._currentUser);
      applyUserPreferences(profile);
    } else {
      window._currentUser = null;
      updateAuthUI(null);
    }
  });

  // Session existante ?
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) {
    const profile = await fetchProfile(session.user.id);
    window._currentUser = { ...session.user, profile };
    updateAuthUI(window._currentUser);
    applyUserPreferences(profile);
  }
}

// ── PROFIL ────────────────────────────────────────────

async function fetchProfile(userId) {
  const sb = await loadSupabase();
  const { data, error } = await sb
    .from('profiles')
    .select('*, bankroll(*), stats(*), subscriptions(*)')
    .eq('id', userId)
    .single();
  if (error) return null;
  return data;
}

async function updateProfile(updates) {
  const sb = await loadSupabase();
  const userId = window._currentUser?.id;
  if (!userId) return;
  const { error } = await sb
    .from('profiles')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', userId);
  if (error) throw error;
}

// ── PRÉFÉRENCES ───────────────────────────────────────

function applyUserPreferences(profile) {
  if (!profile) return;
  // Langue
  if (profile.language && typeof applyLang === 'function') {
    lang = profile.language;
    applyLang();
  }
  // Timezone
  if (profile.user_timezone) {
    window._userTimezone = profile.user_timezone;
  }
  // Format horloge
  if (profile.clock_format) {
    clockIs24h = profile.clock_format === '24h';
    updateClock();
  }
}

// ── UI AUTH ───────────────────────────────────────────

function updateAuthUI(user) {
  const authBtn = document.getElementById('authBtn');
  const authAvatar = document.getElementById('authAvatar');
  const authName = document.getElementById('authName');

  if (!authBtn) return;

  if (user) {
    // Connecté
    authBtn.onclick = () => openSheet('profileModal');
    if (authAvatar) authAvatar.textContent = getAvatarEmoji(user.profile?.avatar_id);
    if (authName) authName.textContent = user.profile?.username || user.email.split('@')[0];
  } else {
    // Non connecté
    authBtn.onclick = () => openSheet('authModal');
    if (authAvatar) authAvatar.textContent = '👤';
    if (authName) authName.textContent = '';
  }
}

function getAvatarEmoji(avatarId) {
  const avatars = {
    'coach_01': '⚡',
    'coach_02': '🎯',
    'coach_03': '🏆',
    'coach_04': '📊',
    'coach_05': '🔥',
  };
  return avatars[avatarId] || '⚡';
}

// ── SAUVEGARDE ANALYSE ────────────────────────────────

async function saveAnalysisToCloud(analysisData) {
  if (!window._currentUser) return; // Pas connecté — pas de sauvegarde cloud
  const sb = await loadSupabase();
  const { error } = await sb.from('analyses').insert({
    user_id: window._currentUser.id,
    matches: analysisData.matches,
    sport: analysisData.matches?.[0]?.sport || 'other',
    competition: analysisData.matches?.[0]?.competition || '',
    result: 'pending'
  });
  if (error) console.warn('Save analysis error:', error.message);
}
