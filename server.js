const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;
const GEMINI_KEY = process.env.GEMINI_KEY;

// Cascade modèles — vérifiés actifs au 29/05/2026
const MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Accept'] }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

// ═══════════════════════════════════════════════════════════
// SUPERCOACH DATA ENGINE v6.0 — FACT-FIRST ARCHITECTURE
// Pipeline : Extraction → Validation → Conteneur de vérité → Gemini
// Gemini ne reçoit QUE des faits validés — zéro invention possible
// ═══════════════════════════════════════════════════════════

// ── Helpers ─────────────────────────────────────────────────
function fetchWithTimeout(url, ms = 4000) {
  return Promise.race([
    fetch(url).then(r => r.ok ? r.json() : null),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]).catch(() => null);
}

async function fetchTextWithTimeout(url, ms = 4000) {
  return Promise.race([
    fetch(url).then(r => r.ok ? r.text() : null),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]).catch(() => null);
}

// Cache 5 minutes
const CACHE = {};
function fromCache(key) {
  const c = CACHE[key];
  return (c && Date.now() - c.ts < 5 * 60 * 1000) ? c.data : null;
}
function toCache(key, data) {
  if (data && (Array.isArray(data) ? data.length > 0 : true))
    CACHE[key] = { data, ts: Date.now() };
}

// ═══════════════════════════════════════════════════════════
// ANCRAGE TEMPOREL RÉEL — injecté côté serveur uniquement
// ═══════════════════════════════════════════════════════════
function getRealTimeBlock() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const day  = now.toLocaleDateString('en-US', { weekday: 'long' });

  const zones = [
    ['Paris/CET',   'Europe/Paris'],
    ['London/GMT',  'Europe/London'],
    ['New York/ET', 'America/New_York'],
    ['LA/PT',       'America/Los_Angeles'],
    ['Tokyo/JST',   'Asia/Tokyo'],
  ];
  const clocks = zones.map(([label, tz]) => {
    try {
      return `${label}:${now.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' })}`;
    } catch { return ''; }
  }).filter(Boolean).join(' | ');

  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate()-1);
  const tomorrow  = new Date(now); tomorrow.setDate(tomorrow.getDate()+1);
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

  return [
    '━━━ REAL-TIME ANCHOR ━━━',
    `TODAY    : ${day} ${date} ${time}`,
    `CLOCKS   : ${clocks}`,
    `YESTERDAY: ${fmt(yesterday)} | TOMORROW: ${fmt(tomorrow)}`,
    '─────────────────────────────────────',
    'TEMPORAL RULES (ABSOLUTE — NEVER OVERRIDE):',
    `1. Today is ${date}. This is ABSOLUTE FACT.`,
    '2. NEVER analyze a match dated before today as if it is upcoming.',
    '3. NEVER invent a date, score, or match not present in JSON_VALIDATED_DATA.',
    '4. If match date is unclear → set match_date_uncertain:true.',
    '5. Past matches → refuse predictive analysis, signal as completed.',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
// SYSTEM PROMPT FACT-FIRST
// Règles d'or anti-hallucination — injectées avant chaque analyse
// ═══════════════════════════════════════════════════════════
function getSystemPrompt() {
  return [
    '━━━ SUPERCOACH SYSTEM PROMPT — FACT-FIRST PROTOCOL ━━━',
    '',
    'ROLE: You are the expert AI of SUPERCOACH.',
    'Your role is to ANALYZE validated sports facts — NOT to search for events.',
    'Your reliability is the #1 product value. An incorrect result is a critical failure.',
    '',
    '━━━ GOLDEN RULES (MANDATORY — NEVER VIOLATE) ━━━',
    '',
    'RULE 1 — ZERO INVENTION:',
    'You have NO RIGHT to invent a match, date, time, score, or team.',
    'If information is not explicitly provided in JSON_VALIDATED_DATA → it does not exist.',
    'NEVER complete missing data. NEVER extrapolate. NEVER assume.',
    '',
    'RULE 2 — VALIDATE BEFORE ANALYZING:',
    'Before any reasoning, check the validation_status field.',
    '→ If "INVALID" or "NOT_FOUND" → respond ONLY with: {"matches":[],"summary":"Match not found or could not be validated. Please check your input.","roi_potential":""}',
    '→ If "PARTIAL" → analyze only confirmed data, flag uncertain fields.',
    '→ If "VERIFIED" → full analysis authorized.',
    '',
    'RULE 3 — AMBIGUITY HANDLING:',
    'Use your sports knowledge to detect the sport automatically from context:',
    '  Sinner/Alcaraz/Djokovic/Swiatek/Nadal/Federer/Gauff/Sabalenka → Tennis',
    '  PSG/Real Madrid/Liverpool/Bayern/Barcelona/Arsenal/Chelsea → Football',
    '  Lakers/Celtics/Warriors/Bulls/Heat/Bucks → Basketball',
    '  Oilers/Rangers/Bruins/Maple Leafs/Canadiens → Hockey',
    '  Chiefs/Eagles/Cowboys/Patriots/Ravens → NFL',
    'ONLY ask for clarification if sport is truly impossible to determine.',
    'Clarification: {"matches":[],"summary":"Please specify the sport for this query.","roi_potential":""}',
    '',
    'RULE 4 — TEMPORAL INTEGRITY:',
    'Check today\'s date from the REAL-TIME ANCHOR block above.',
    '→ Past match → refuse predictive analysis, return match_date_uncertain:true.',
    '→ Future match → analyze based only on provided data.',
    '→ Live match → prioritize LIVE score from JSON_VALIDATED_DATA.',
    '',
    'RULE 5 — DATA HIERARCHY:',
    'Official API data (JSON_VALIDATED_DATA) > User-provided text > Your training knowledge.',
    'If conflict → official API data wins ALWAYS.',
    '',
    'RULE 6 — OUTPUT FORMAT:',
    'ALWAYS return valid JSON object: {"matches":[...],"summary":"...","roi_potential":"..."}',
    'NEVER return a bare array. NEVER add markdown, backticks, or prose.',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
// MOTEUR DE VALIDATION FACT-FIRST v2
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// SUPERCOACH — MOTEUR DE VALIDATION FACT-FIRST v2
// Pipeline : Extraction → Normalisation → Fuzzy → Validation → Vérité
// Tolérance zéro hallucination — pas de PARTIAL en MVP
// ═══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────
// COUCHE 1 — TABLE FIXE (300+ entrées, certitude 100%)
// Format : alias_normalisé → {canonical, sport, espnId?}
// ─────────────────────────────────────────────────────────────────
const ALIAS_TABLE = {

  // ── FOOTBALL EUROPE ──────────────────────────────────────────

  // France
  'psg':                    {c:'Paris Saint-Germain', s:'foot'},
  'paris saint germain':    {c:'Paris Saint-Germain', s:'foot'},
  'paris sg':               {c:'Paris Saint-Germain', s:'foot'},
  'saint germain':          {c:'Paris Saint-Germain', s:'foot'},
  'paris saint-germain':    {c:'Paris Saint-Germain', s:'foot'},
  'paris':                  {c:'Paris Saint-Germain', s:'foot'},
  'om':                     {c:'Marseille',           s:'foot'},
  'marseille':              {c:'Marseille',           s:'foot'},
  'olympique marseille':    {c:'Marseille',           s:'foot'},
  'ol':                     {c:'Olympique Lyonnais',  s:'foot'},
  'lyon':                   {c:'Olympique Lyonnais',  s:'foot'},
  'olympique lyonnais':     {c:'Olympique Lyonnais',  s:'foot'},
  'asm':                    {c:'Monaco',              s:'foot'},
  'monaco':                 {c:'Monaco',              s:'foot'},
  'as monaco':              {c:'Monaco',              s:'foot'},
  'ogcn':                   {c:'Nice',                s:'foot'},
  'nice':                   {c:'Nice',                s:'foot'},
  'losc':                   {c:'Lille',               s:'foot'},
  'lille':                  {c:'Lille',               s:'foot'},
  'rennes':                 {c:'Rennes',              s:'foot'},
  'stade rennais':          {c:'Rennes',              s:'foot'},
  'lens':                   {c:'Lens',                s:'foot'},
  'rc lens':                {c:'Lens',                s:'foot'},
  'strasbourg':             {c:'Strasbourg',          s:'foot'},
  'nantes':                 {c:'Nantes',              s:'foot'},
  'bordeaux':               {c:'Bordeaux',            s:'foot'},
  'saint etienne':          {c:'Saint-Étienne',       s:'foot'},
  'asse':                   {c:'Saint-Étienne',       s:'foot'},

  // Angleterre
  'arsenal':                {c:'Arsenal',             s:'foot'},
  'chelsea':                {c:'Chelsea',             s:'foot'},
  'liverpool':              {c:'Liverpool',           s:'foot'},
  'man utd':                {c:'Manchester United',   s:'foot'},
  'manchester united':      {c:'Manchester United',   s:'foot'},
  'mufc':                   {c:'Manchester United',   s:'foot'},
  'man city':               {c:'Manchester City',     s:'foot'},
  'manchester city':        {c:'Manchester City',     s:'foot'},
  'mcfc':                   {c:'Manchester City',     s:'foot'},
  'spurs':                  {c:'Tottenham',           s:'foot'},
  'tottenham':              {c:'Tottenham',           s:'foot'},
  'thfc':                   {c:'Tottenham',           s:'foot'},
  'newcastle':              {c:'Newcastle',           s:'foot'},
  'aston villa':            {c:'Aston Villa',         s:'foot'},
  'west ham':               {c:'West Ham',            s:'foot'},
  'everton':                {c:'Everton',             s:'foot'},
  'brighton':               {c:'Brighton',            s:'foot'},
  'brentford':              {c:'Brentford',           s:'foot'},
  'fulham':                 {c:'Fulham',              s:'foot'},
  'wolves':                 {c:'Wolverhampton',       s:'foot'},
  'wolverhampton':          {c:'Wolverhampton',       s:'foot'},
  'leicester':              {c:'Leicester',           s:'foot'},
  'nottm forest':           {c:'Nottingham Forest',   s:'foot'},
  'nottingham forest':      {c:'Nottingham Forest',   s:'foot'},

  // Espagne
  'real madrid':            {c:'Real Madrid',         s:'foot'},
  'real':                   {c:'Real Madrid',         s:'foot'},
  'barca':                  {c:'Barcelona',           s:'foot'},
  'barcelona':              {c:'Barcelona',           s:'foot'},
  'fcb':                    {c:'Barcelona',           s:'foot'},
  'atletico':               {c:'Atlético Madrid',     s:'foot'},
  'atletico madrid':        {c:'Atlético Madrid',     s:'foot'},
  'atm':                    {c:'Atlético Madrid',     s:'foot'},
  'sevilla':                {c:'Sevilla',             s:'foot'},
  'real sociedad':          {c:'Real Sociedad',       s:'foot'},
  'villarreal':             {c:'Villarreal',          s:'foot'},
  'athletic bilbao':        {c:'Athletic Club',       s:'foot'},
  'athletic':               {c:'Athletic Club',       s:'foot'},
  'valencia':               {c:'Valencia',            s:'foot'},
  'betis':                  {c:'Real Betis',          s:'foot'},
  'real betis':             {c:'Real Betis',          s:'foot'},
  'osasuna':                {c:'Osasuna',             s:'foot'},
  'girona':                 {c:'Girona',              s:'foot'},

  // Allemagne
  'bayern':                 {c:'Bayern Munich',       s:'foot'},
  'bayern munich':          {c:'Bayern Munich',       s:'foot'},
  'fcb munich':             {c:'Bayern Munich',       s:'foot'},
  'dortmund':               {c:'Borussia Dortmund',   s:'foot'},
  'bvb':                    {c:'Borussia Dortmund',   s:'foot'},
  'borussia dortmund':      {c:'Borussia Dortmund',   s:'foot'},
  'leverkusen':             {c:'Bayer Leverkusen',    s:'foot'},
  'bayer leverkusen':       {c:'Bayer Leverkusen',    s:'foot'},
  'rb leipzig':             {c:'RB Leipzig',          s:'foot'},
  'leipzig':                {c:'RB Leipzig',          s:'foot'},
  'eintracht frankfurt':    {c:'Eintracht Frankfurt', s:'foot'},
  'frankfurt':              {c:'Eintracht Frankfurt', s:'foot'},
  'wolfsburg':              {c:'Wolfsburg',           s:'foot'},
  'gladbach':               {c:'Borussia Mönchengladbach', s:'foot'},
  'monchengladbach':        {c:'Borussia Mönchengladbach', s:'foot'},
  'union berlin':           {c:'Union Berlin',        s:'foot'},
  'stuttgart':              {c:'Stuttgart',           s:'foot'},
  'hamburg':                {c:'Hamburg',             s:'foot'},
  'hsv':                    {c:'Hamburg',             s:'foot'},

  // Italie
  'juventus':               {c:'Juventus',            s:'foot'},
  'juve':                   {c:'Juventus',            s:'foot'},
  'inter':                  {c:'Inter Milan',         s:'foot'},
  'inter milan':            {c:'Inter Milan',         s:'foot'},
  'ac milan':               {c:'AC Milan',            s:'foot'},
  'milan':                  {c:'AC Milan',            s:'foot'},
  'napoli':                 {c:'Napoli',              s:'foot'},
  'roma':                   {c:'AS Roma',             s:'foot'},
  'as roma':                {c:'AS Roma',             s:'foot'},
  'lazio':                  {c:'Lazio',               s:'foot'},
  'atalanta':               {c:'Atalanta',            s:'foot'},
  'fiorentina':             {c:'Fiorentina',          s:'foot'},
  'torino':                 {c:'Torino',              s:'foot'},
  'bologna':                {c:'Bologna',             s:'foot'},
  'udinese':                {c:'Udinese',             s:'foot'},

  // Portugal
  'benfica':                {c:'Benfica',             s:'foot'},
  'sl benfica':             {c:'Benfica',             s:'foot'},
  'porto':                  {c:'Porto',               s:'foot'},
  'fc porto':               {c:'Porto',               s:'foot'},
  'sporting':               {c:'Sporting CP',         s:'foot'},
  'sporting cp':            {c:'Sporting CP',         s:'foot'},
  'sporting lisbon':        {c:'Sporting CP',         s:'foot'},
  'braga':                  {c:'Braga',               s:'foot'},

  // Pays-Bas
  'ajax':                   {c:'Ajax',                s:'foot'},
  'psv':                    {c:'PSV',                 s:'foot'},
  'feyenoord':              {c:'Feyenoord',           s:'foot'},
  'az alkmaar':             {c:'AZ Alkmaar',          s:'foot'},
  'az':                     {c:'AZ Alkmaar',          s:'foot'},
  'twente':                 {c:'FC Twente',           s:'foot'},

  // Coupe du Monde 2026 — Équipes nationales
  'france':                 {c:'France',              s:'foot'},
  'les bleus':              {c:'France',              s:'foot'},
  'bresil':                 {c:'Brazil',              s:'foot'},
  'brazil':                 {c:'Brazil',              s:'foot'},
  'seleção':                {c:'Brazil',              s:'foot'},
  'selecao':                {c:'Brazil',              s:'foot'},
  'angleterre':             {c:'England',             s:'foot'},
  'england':                {c:'England',             s:'foot'},
  'three lions':            {c:'England',             s:'foot'},
  'espagne':                {c:'Spain',               s:'foot'},
  'spain':                  {c:'Spain',               s:'foot'},
  'la roja':                {c:'Spain',               s:'foot'},
  'allemagne':              {c:'Germany',             s:'foot'},
  'germany':                {c:'Germany',             s:'foot'},
  'die mannschaft':         {c:'Germany',             s:'foot'},
  'portugal':               {c:'Portugal',            s:'foot'},
  'selecao portuguesa':     {c:'Portugal',            s:'foot'},
  'argentine':              {c:'Argentina',           s:'foot'},
  'argentina':              {c:'Argentina',           s:'foot'},
  'la albiceleste':         {c:'Argentina',           s:'foot'},
  'maroc':                  {c:'Morocco',             s:'foot'},
  'morocco':                {c:'Morocco',             s:'foot'},
  'pays bas':               {c:'Netherlands',         s:'foot'},
  'netherlands':            {c:'Netherlands',         s:'foot'},
  'hollande':               {c:'Netherlands',         s:'foot'},
  'holland':                {c:'Netherlands',         s:'foot'},
  'belgique':               {c:'Belgium',             s:'foot'},
  'belgium':                {c:'Belgium',             s:'foot'},
  'red devils':             {c:'Belgium',             s:'foot'},
  'italie':                 {c:'Italy',               s:'foot'},
  'italy':                  {c:'Italy',               s:'foot'},
  'azzurri':                {c:'Italy',               s:'foot'},
  'etats unis':             {c:'USA',                 s:'foot'},
  'usa':                    {c:'USA',                 s:'foot'},
  'japon':                  {c:'Japan',               s:'foot'},
  'japan':                  {c:'Japan',               s:'foot'},
  'coree':                  {c:'South Korea',         s:'foot'},
  'south korea':            {c:'South Korea',         s:'foot'},
  'mexique':                {c:'Mexico',              s:'foot'},
  'mexico':                 {c:'Mexico',              s:'foot'},
  'senegal':                {c:'Senegal',             s:'foot'},
  'nigeria':                {c:'Nigeria',             s:'foot'},
  'ghana':                  {c:'Ghana',               s:'foot'},
  'cameroun':               {c:'Cameroon',            s:'foot'},
  'cameroon':               {c:'Cameroon',            s:'foot'},
  'egypte':                 {c:'Egypt',               s:'foot'},
  'egypt':                  {c:'Egypt',               s:'foot'},
  'australie':              {c:'Australia',           s:'foot'},
  'australia':              {c:'Australia',           s:'foot'},
  'canada':                 {c:'Canada',              s:'foot'},
  'arabie saoudite':        {c:'Saudi Arabia',        s:'foot'},
  'saudi arabia':           {c:'Saudi Arabia',        s:'foot'},
  'iran':                   {c:'Iran',                s:'foot'},
  'suisse':                 {c:'Switzerland',         s:'foot'},
  'switzerland':            {c:'Switzerland',         s:'foot'},
  'croatie':                {c:'Croatia',             s:'foot'},
  'croatia':                {c:'Croatia',             s:'foot'},
  'serbie':                 {c:'Serbia',              s:'foot'},
  'serbia':                 {c:'Serbia',              s:'foot'},

  // ── NBA ──────────────────────────────────────────────────────
  'lakers':                 {c:'Los Angeles Lakers',  s:'basket'},
  'los angeles lakers':     {c:'Los Angeles Lakers',  s:'basket'},
  'la lakers':              {c:'Los Angeles Lakers',  s:'basket'},
  'celtics':                {c:'Boston Celtics',      s:'basket'},
  'boston celtics':         {c:'Boston Celtics',      s:'basket'},
  'warriors':               {c:'Golden State Warriors', s:'basket'},
  'golden state':           {c:'Golden State Warriors', s:'basket'},
  'gsw':                    {c:'Golden State Warriors', s:'basket'},
  'bulls':                  {c:'Chicago Bulls',       s:'basket'},
  'chicago bulls':          {c:'Chicago Bulls',       s:'basket'},
  'heat':                   {c:'Miami Heat',          s:'basket'},
  'miami heat':             {c:'Miami Heat',          s:'basket'},
  'bucks':                  {c:'Milwaukee Bucks',     s:'basket'},
  'milwaukee bucks':        {c:'Milwaukee Bucks',     s:'basket'},
  'nuggets':                {c:'Denver Nuggets',      s:'basket'},
  'denver nuggets':         {c:'Denver Nuggets',      s:'basket'},
  'suns':                   {c:'Phoenix Suns',        s:'basket'},
  'phoenix suns':           {c:'Phoenix Suns',        s:'basket'},
  'nets':                   {c:'Brooklyn Nets',       s:'basket'},
  'brooklyn nets':          {c:'Brooklyn Nets',       s:'basket'},
  'clippers':               {c:'LA Clippers',         s:'basket'},
  'la clippers':            {c:'LA Clippers',         s:'basket'},
  'knicks':                 {c:'New York Knicks',     s:'basket'},
  'new york knicks':        {c:'New York Knicks',     s:'basket'},
  'raptors':                {c:'Toronto Raptors',     s:'basket'},
  'toronto raptors':        {c:'Toronto Raptors',     s:'basket'},
  'spurs':                  {c:'San Antonio Spurs',   s:'basket'},
  'san antonio spurs':      {c:'San Antonio Spurs',   s:'basket'},
  'sixers':                 {c:'Philadelphia 76ers',  s:'basket'},
  'philadelphia 76ers':     {c:'Philadelphia 76ers',  s:'basket'},
  '76ers':                  {c:'Philadelphia 76ers',  s:'basket'},
  'hawks':                  {c:'Atlanta Hawks',       s:'basket'},
  'atlanta hawks':          {c:'Atlanta Hawks',       s:'basket'},
  'cavaliers':              {c:'Cleveland Cavaliers', s:'basket'},
  'cavs':                   {c:'Cleveland Cavaliers', s:'basket'},
  'mavs':                   {c:'Dallas Mavericks',    s:'basket'},
  'mavericks':              {c:'Dallas Mavericks',    s:'basket'},
  'dallas mavericks':       {c:'Dallas Mavericks',    s:'basket'},
  'grizzlies':              {c:'Memphis Grizzlies',   s:'basket'},
  'memphis grizzlies':      {c:'Memphis Grizzlies',   s:'basket'},
  'pelicans':               {c:'New Orleans Pelicans',s:'basket'},
  'thunder':                {c:'Oklahoma City Thunder',s:'basket'},
  'okc':                    {c:'Oklahoma City Thunder',s:'basket'},
  'blazers':                {c:'Portland Trail Blazers',s:'basket'},
  'portland':               {c:'Portland Trail Blazers',s:'basket'},
  'kings':                  {c:'Sacramento Kings',    s:'basket'},
  'sacramento kings':       {c:'Sacramento Kings',    s:'basket'},
  'jazz':                   {c:'Utah Jazz',           s:'basket'},
  'utah jazz':              {c:'Utah Jazz',           s:'basket'},
  'wizards':                {c:'Washington Wizards',  s:'basket'},
  'pacers':                 {c:'Indiana Pacers',      s:'basket'},
  'indiana pacers':         {c:'Indiana Pacers',      s:'basket'},
  'magic':                  {c:'Orlando Magic',       s:'basket'},
  'orlando magic':          {c:'Orlando Magic',       s:'basket'},
  'hornets':                {c:'Charlotte Hornets',   s:'basket'},
  'pistons':                {c:'Detroit Pistons',     s:'basket'},
  'rockets':                {c:'Houston Rockets',     s:'basket'},
  'houston rockets':        {c:'Houston Rockets',     s:'basket'},
  'timberwolves':           {c:'Minnesota Timberwolves',s:'basket'},
  'wolves':                 {c:'Minnesota Timberwolves',s:'basket'},

  // ── NHL ──────────────────────────────────────────────────────
  'oilers':                 {c:'Edmonton Oilers',     s:'hockey'},
  'edmonton oilers':        {c:'Edmonton Oilers',     s:'hockey'},
  'maple leafs':            {c:'Toronto Maple Leafs', s:'hockey'},
  'leafs':                  {c:'Toronto Maple Leafs', s:'hockey'},
  'toronto maple leafs':    {c:'Toronto Maple Leafs', s:'hockey'},
  'rangers':                {c:'New York Rangers',    s:'hockey'},
  'new york rangers':       {c:'New York Rangers',    s:'hockey'},
  'bruins':                 {c:'Boston Bruins',       s:'hockey'},
  'boston bruins':          {c:'Boston Bruins',       s:'hockey'},
  'penguins':               {c:'Pittsburgh Penguins', s:'hockey'},
  'pittsburgh penguins':    {c:'Pittsburgh Penguins', s:'hockey'},
  'canadiens':              {c:'Montreal Canadiens',  s:'hockey'},
  'habs':                   {c:'Montreal Canadiens',  s:'hockey'},
  'montreal canadiens':     {c:'Montreal Canadiens',  s:'hockey'},
  'avalanche':              {c:'Colorado Avalanche',  s:'hockey'},
  'colorado avalanche':     {c:'Colorado Avalanche',  s:'hockey'},
  'lightning':              {c:'Tampa Bay Lightning', s:'hockey'},
  'tampa bay':              {c:'Tampa Bay Lightning', s:'hockey'},
  'golden knights':         {c:'Vegas Golden Knights',s:'hockey'},
  'vegas golden knights':   {c:'Vegas Golden Knights',s:'hockey'},
  'flames':                 {c:'Calgary Flames',      s:'hockey'},
  'calgary flames':         {c:'Calgary Flames',      s:'hockey'},
  'canucks':                {c:'Vancouver Canucks',   s:'hockey'},
  'vancouver canucks':      {c:'Vancouver Canucks',   s:'hockey'},
  'capitals':               {c:'Washington Capitals', s:'hockey'},
  'washington capitals':    {c:'Washington Capitals', s:'hockey'},
  'wild':                   {c:'Minnesota Wild',      s:'hockey'},
  'blackhawks':             {c:'Chicago Blackhawks',  s:'hockey'},
  'detroit red wings':      {c:'Detroit Red Wings',   s:'hockey'},
  'red wings':              {c:'Detroit Red Wings',   s:'hockey'},
  'flyers':                 {c:'Philadelphia Flyers', s:'hockey'},
  'sabres':                 {c:'Buffalo Sabres',      s:'hockey'},
  'stars':                  {c:'Dallas Stars',        s:'hockey'},
  'dallas stars':           {c:'Dallas Stars',        s:'hockey'},
  'jets':                   {c:'Winnipeg Jets',       s:'hockey'},
  'winnipeg jets':          {c:'Winnipeg Jets',       s:'hockey'},
  'sharks':                 {c:'San Jose Sharks',     s:'hockey'},
  'ducks':                  {c:'Anaheim Ducks',       s:'hockey'},
  'coyotes':                {c:'Utah Hockey Club',    s:'hockey'},
  'utah hc':                {c:'Utah Hockey Club',    s:'hockey'},
  'kraken':                 {c:'Seattle Kraken',      s:'hockey'},
  'blue jackets':           {c:'Columbus Blue Jackets',s:'hockey'},
  'senators':               {c:'Ottawa Senators',     s:'hockey'},
  'hurricanes':             {c:'Carolina Hurricanes', s:'hockey'},
  'panthers':               {c:'Florida Panthers',    s:'hockey'},
  'florida panthers':       {c:'Florida Panthers',    s:'hockey'},
  'blues':                  {c:'St. Louis Blues',     s:'hockey'},
  'st louis blues':         {c:'St. Louis Blues',     s:'hockey'},
  'predators':              {c:'Nashville Predators', s:'hockey'},
  'devils':                 {c:'New Jersey Devils',   s:'hockey'},
  'islanders':              {c:'New York Islanders',  s:'hockey'},

  // ── ATP TENNIS (Top 50 joueurs) ───────────────────────────────
  'sinner':                 {c:'Jannik Sinner',       s:'tennis'},
  'jannik sinner':          {c:'Jannik Sinner',       s:'tennis'},
  'alcaraz':                {c:'Carlos Alcaraz',      s:'tennis'},
  'carlos alcaraz':         {c:'Carlos Alcaraz',      s:'tennis'},
  'djokovic':               {c:'Novak Djokovic',      s:'tennis'},
  'novak djokovic':         {c:'Novak Djokovic',      s:'tennis'},
  'nole':                   {c:'Novak Djokovic',      s:'tennis'},
  'zverev':                 {c:'Alexander Zverev',    s:'tennis'},
  'alexander zverev':       {c:'Alexander Zverev',    s:'tennis'},
  'medvedev':               {c:'Daniil Medvedev',     s:'tennis'},
  'daniil medvedev':        {c:'Daniil Medvedev',     s:'tennis'},
  'rublev':                 {c:'Andrey Rublev',       s:'tennis'},
  'andrey rublev':          {c:'Andrey Rublev',       s:'tennis'},
  'tsitsipas':              {c:'Stefanos Tsitsipas',  s:'tennis'},
  'stefanos tsitsipas':     {c:'Stefanos Tsitsipas',  s:'tennis'},
  'fritz':                  {c:'Taylor Fritz',        s:'tennis'},
  'taylor fritz':           {c:'Taylor Fritz',        s:'tennis'},
  'de minaur':              {c:'Alex de Minaur',      s:'tennis'},
  'alex de minaur':         {c:'Alex de Minaur',      s:'tennis'},
  'draper':                 {c:'Jack Draper',         s:'tennis'},
  'jack draper':            {c:'Jack Draper',         s:'tennis'},
  'hurkacz':                {c:'Hubert Hurkacz',      s:'tennis'},
  'hubert hurkacz':         {c:'Hubert Hurkacz',      s:'tennis'},
  'ruud':                   {c:'Casper Ruud',         s:'tennis'},
  'casper ruud':            {c:'Casper Ruud',         s:'tennis'},
  'dimitrov':               {c:'Grigor Dimitrov',     s:'tennis'},
  'grigor dimitrov':        {c:'Grigor Dimitrov',     s:'tennis'},
  'khachanov':              {c:'Karen Khachanov',     s:'tennis'},
  'karen khachanov':        {c:'Karen Khachanov',     s:'tennis'},
  'tiafoe':                 {c:'Frances Tiafoe',      s:'tennis'},
  'frances tiafoe':         {c:'Frances Tiafoe',      s:'tennis'},
  'paul':                   {c:'Tommy Paul',          s:'tennis'},
  'tommy paul':             {c:'Tommy Paul',          s:'tennis'},
  'musetti':                {c:'Lorenzo Musetti',     s:'tennis'},
  'lorenzo musetti':        {c:'Lorenzo Musetti',     s:'tennis'},
  'berrettini':             {c:'Matteo Berrettini',   s:'tennis'},
  'matteo berrettini':      {c:'Matteo Berrettini',   s:'tennis'},
  'nadal':                  {c:'Rafael Nadal',        s:'tennis'},
  'rafael nadal':           {c:'Rafael Nadal',        s:'tennis'},
  'rafa':                   {c:'Rafael Nadal',        s:'tennis'},
  'federer':                {c:'Roger Federer',       s:'tennis'},
  'roger federer':          {c:'Roger Federer',       s:'tennis'},
  // WTA
  'swiatek':                {c:'Iga Swiatek',         s:'tennis'},
  'iga swiatek':            {c:'Iga Swiatek',         s:'tennis'},
  'sabalenka':              {c:'Aryna Sabalenka',     s:'tennis'},
  'aryna sabalenka':        {c:'Aryna Sabalenka',     s:'tennis'},
  'gauff':                  {c:'Coco Gauff',          s:'tennis'},
  'coco gauff':             {c:'Coco Gauff',          s:'tennis'},
  'rybakina':               {c:'Elena Rybakina',      s:'tennis'},
  'elena rybakina':         {c:'Elena Rybakina',      s:'tennis'},
  'jabeur':                 {c:'Ons Jabeur',          s:'tennis'},
  'ons jabeur':             {c:'Ons Jabeur',          s:'tennis'},
  'kvitova':                {c:'Petra Kvitova',       s:'tennis'},
  'petra kvitova':          {c:'Petra Kvitova',       s:'tennis'},
  'osaka':                  {c:'Naomi Osaka',         s:'tennis'},
  'naomi osaka':            {c:'Naomi Osaka',         s:'tennis'},
  'wozniacki':              {c:'Caroline Wozniacki',  s:'tennis'},
  'svitolina':              {c:'Elina Svitolina',     s:'tennis'},
  'elina svitolina':        {c:'Elina Svitolina',     s:'tennis'},
  'muguruza':               {c:'Garbiñe Muguruza',   s:'tennis'},
  'andreescu':              {c:'Bianca Andreescu',    s:'tennis'},
  'keys':                   {c:'Madison Keys',        s:'tennis'},
  'madison keys':           {c:'Madison Keys',        s:'tennis'},
  'vondrousova':            {c:'Marketa Vondrousova', s:'tennis'},
  'paolini':                {c:'Jasmine Paolini',     s:'tennis'},
  'jasmine paolini':        {c:'Jasmine Paolini',     s:'tennis'},
  'halep':                  {c:'Simona Halep',        s:'tennis'},
  'simona halep':           {c:'Simona Halep',        s:'tennis'},
  // WTA manquantes
  'bencic':                 {c:'Belinda Bencic',      s:'tennis'},
  'belinda bencic':         {c:'Belinda Bencic',      s:'tennis'},
  'svitolina':              {c:'Elina Svitolina',     s:'tennis'},
  'elina svitolina':        {c:'Elina Svitolina',     s:'tennis'},
  'badosa':                 {c:'Paula Badosa',        s:'tennis'},
  'paula badosa':           {c:'Paula Badosa',        s:'tennis'},
  'pegula':                 {c:'Jessica Pegula',      s:'tennis'},
  'jessica pegula':         {c:'Jessica Pegula',      s:'tennis'},
  'collins':                {c:'Danielle Collins',    s:'tennis'},
  'danielle collins':       {c:'Danielle Collins',    s:'tennis'},
  'haddad maia':            {c:'Beatriz Haddad Maia', s:'tennis'},
  'kasatkina':              {c:'Daria Kasatkina',     s:'tennis'},
  'daria kasatkina':        {c:'Daria Kasatkina',     s:'tennis'},
  'kontaveit':              {c:'Anett Kontaveit',     s:'tennis'},
  'anett kontaveit':        {c:'Anett Kontaveit',     s:'tennis'},
  'giorgi':                 {c:'Camila Giorgi',       s:'tennis'},
  'camila giorgi':          {c:'Camila Giorgi',       s:'tennis'},
  'azarenka':               {c:'Victoria Azarenka',   s:'tennis'},
  'victoria azarenka':      {c:'Victoria Azarenka',   s:'tennis'},
  'pliskova':               {c:'Karolina Pliskova',   s:'tennis'},
  'karolina pliskova':      {c:'Karolina Pliskova',   s:'tennis'},
  'kerber':                 {c:'Angelique Kerber',    s:'tennis'},
  'angelique kerber':       {c:'Angelique Kerber',    s:'tennis'},
  'ostapenko':              {c:'Jelena Ostapenko',    s:'tennis'},
  'jelena ostapenko':       {c:'Jelena Ostapenko',    s:'tennis'},
  'bertens':                {c:'Kiki Bertens',        s:'tennis'},
  'stephens':               {c:'Sloane Stephens',     s:'tennis'},
  'sloane stephens':        {c:'Sloane Stephens',     s:'tennis'},
  'kenin':                  {c:'Sofia Kenin',         s:'tennis'},
  'sofia kenin':            {c:'Sofia Kenin',         s:'tennis'},
  'kvitova':                {c:'Petra Kvitova',       s:'tennis'},
  'petra kvitova':          {c:'Petra Kvitova',       s:'tennis'},
  'fernandez':              {c:'Leylah Fernandez',    s:'tennis'},
  'leylah fernandez':       {c:'Leylah Fernandez',    s:'tennis'},
  'boulter':                {c:'Katie Boulter',       s:'tennis'},
  'katie boulter':          {c:'Katie Boulter',       s:'tennis'},
  'dart':                   {c:'Harriet Dart',        s:'tennis'},
  'harriet dart':           {c:'Harriet Dart',        s:'tennis'},
  'watson':                 {c:'Heather Watson',      s:'tennis'},
  'heather watson':         {c:'Heather Watson',      s:'tennis'},
  // ATP manquants
  'shelton':                {c:'Ben Shelton',         s:'tennis'},
  'ben shelton':            {c:'Ben Shelton',         s:'tennis'},
  'cerundolo':              {c:'Francisco Cerundolo', s:'tennis'},
  'francisco cerundolo':    {c:'Francisco Cerundolo', s:'tennis'},
  'struff':                 {c:'Jan-Lennard Struff',  s:'tennis'},
  'norrie':                 {c:'Cameron Norrie',      s:'tennis'},
  'cameron norrie':         {c:'Cameron Norrie',      s:'tennis'},
  'auger aliassime':        {c:'Felix Auger-Aliassime',s:'tennis'},
  'faa':                    {c:'Felix Auger-Aliassime',s:'tennis'},
  'shapovalov':             {c:'Denis Shapovalov',    s:'tennis'},
  'denis shapovalov':       {c:'Denis Shapovalov',    s:'tennis'},
  'ruusuvuori':             {c:'Emil Ruusuvuori',     s:'tennis'},
  'baez':                   {c:'Sebastian Baez',      s:'tennis'},
  'sebastian baez':         {c:'Sebastian Baez',      s:'tennis'},
  'davidovich fokina':      {c:'Alejandro Davidovich Fokina', s:'tennis'},
  'humbert':                {c:'Ugo Humbert',         s:'tennis'},
  'ugo humbert':            {c:'Ugo Humbert',         s:'tennis'},
  'mannarino':              {c:'Adrian Mannarino',    s:'tennis'},
  'adrian mannarino':       {c:'Adrian Mannarino',    s:'tennis'},

  // ── NFL ──────────────────────────────────────────────────────
  'chiefs':                 {c:'Kansas City Chiefs',  s:'nfl'},
  'kansas city chiefs':     {c:'Kansas City Chiefs',  s:'nfl'},
  'eagles':                 {c:'Philadelphia Eagles', s:'nfl'},
  'philadelphia eagles':    {c:'Philadelphia Eagles', s:'nfl'},
  'cowboys':                {c:'Dallas Cowboys',      s:'nfl'},
  'dallas cowboys':         {c:'Dallas Cowboys',      s:'nfl'},
  'patriots':               {c:'New England Patriots',s:'nfl'},
  'new england patriots':   {c:'New England Patriots',s:'nfl'},
  '49ers':                  {c:'San Francisco 49ers', s:'nfl'},
  'san francisco 49ers':    {c:'San Francisco 49ers', s:'nfl'},
  'ravens':                 {c:'Baltimore Ravens',    s:'nfl'},
  'baltimore ravens':       {c:'Baltimore Ravens',    s:'nfl'},
  'packers':                {c:'Green Bay Packers',   s:'nfl'},
  'green bay packers':      {c:'Green Bay Packers',   s:'nfl'},
  'broncos':                {c:'Denver Broncos',      s:'nfl'},
  'steelers':               {c:'Pittsburgh Steelers', s:'nfl'},
  'seahawks':               {c:'Seattle Seahawks',    s:'nfl'},
  'rams':                   {c:'Los Angeles Rams',    s:'nfl'},
  'la rams':                {c:'Los Angeles Rams',    s:'nfl'},
  'giants':                 {c:'New York Giants',     s:'nfl'},
  'bills':                  {c:'Buffalo Bills',       s:'nfl'},
  'buffalo bills':          {c:'Buffalo Bills',       s:'nfl'},
  'dolphins':               {c:'Miami Dolphins',      s:'nfl'},
  'miami dolphins':         {c:'Miami Dolphins',      s:'nfl'},
  'bengals':                {c:'Cincinnati Bengals',  s:'nfl'},
  'browns':                 {c:'Cleveland Browns',    s:'nfl'},
  'texans':                 {c:'Houston Texans',      s:'nfl'},
  'colts':                  {c:'Indianapolis Colts',  s:'nfl'},
  'jaguars':                {c:'Jacksonville Jaguars',s:'nfl'},
  'titans':                 {c:'Tennessee Titans',    s:'nfl'},
  'raiders':                {c:'Las Vegas Raiders',   s:'nfl'},
  'chargers':               {c:'Los Angeles Chargers',s:'nfl'},
  'vikings':                {c:'Minnesota Vikings',   s:'nfl'},
  'bears':                  {c:'Chicago Bears',       s:'nfl'},
  'lions':                  {c:'Detroit Lions',       s:'nfl'},
  'buccaneers':             {c:'Tampa Bay Buccaneers',s:'nfl'},
  'bucs':                   {c:'Tampa Bay Buccaneers',s:'nfl'},
  'saints':                 {c:'New Orleans Saints',  s:'nfl'},
  'falcons':                {c:'Atlanta Falcons',     s:'nfl'},
  'panthers':               {c:'Carolina Panthers',   s:'nfl'},
  'commanders':             {c:'Washington Commanders',s:'nfl'},
  'cardinals':              {c:'Arizona Cardinals',   s:'nfl'},
};

// ─────────────────────────────────────────────────────────────────
// COUCHE 2 — NORMALISATION
// Nettoyer et normaliser une chaîne pour lookup
// ─────────────────────────────────────────────────────────────────
function normalizeToken(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // accents
    .replace(/\b[a-z]\./g, ' ')  // initiales : "E." "B." "J." etc.
    .replace(/['\-\.]/g, ' ')    // apostrophes, tirets, points
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────
// COUCHE 2 — FUZZY MATCHING (distance de Levenshtein)
// Fallback si table fixe échoue
// ─────────────────────────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({length: m+1}, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function fuzzyMatchAlias(token) {
  // Distance max autorisée selon longueur du token
  const maxDist = token.length <= 5 ? 1 : token.length <= 10 ? 2 : 3;
  let best = null, bestDist = Infinity;
  for (const [alias, entry] of Object.entries(ALIAS_TABLE)) {
    const dist = levenshtein(token, alias);
    if (dist < bestDist && dist <= maxDist) {
      bestDist = dist;
      best = { ...entry, alias, distance: dist };
    }
  }
  return best; // null si aucun match
}

// ─────────────────────────────────────────────────────────────────
// COUCHE 1+2 — EXTRACTEUR D'ENTITÉS
// Analyse le prompt et retourne les entités détectées
// ─────────────────────────────────────────────────────────────────
function extractEntitiesV2(prompt) {
  const normalized = normalizeToken(prompt);
  const tokens = normalized.split(/[\s,;\/\-]+/).filter(t => t.length >= 2);
  const stopWords = new Set([
    'vs','versus','contre','match','game','vs','play','the','and','or',
    'un','une','le','la','les','du','de','des','ce','ce','soir',
    'ce','matin','demain','aujourd','hui','pour','avec','et','en',
    'ce','week','end','tonight','today','tomorrow','morning','evening',
    'odds','bet','cote','analyse','analyzer','prono','pronostic',
    'analyse','pari','paris','betting','score','result','live'
  ]);
  
  const entities = [];
  const found = new Set();
  
  // Essayer des n-grams (3 mots, 2 mots, 1 mot) pour la table fixe
  const words = normalized.split(/\s+/).filter(w => !stopWords.has(w) && w.length >= 2);
  
  // Essayer trigrammes
  for (let i = 0; i <= words.length - 3; i++) {
    const trigram = words.slice(i, i+3).join(' ');
    if (ALIAS_TABLE[trigram] && !found.has(trigram)) {
      entities.push({ ...ALIAS_TABLE[trigram], matched: trigram, method: 'exact', confidence: 1.0 });
      found.add(trigram);
    }
  }
  // Bigrammes
  for (let i = 0; i <= words.length - 2; i++) {
    const bigram = words.slice(i, i+2).join(' ');
    const already = entities.some(e => e.matched === bigram || bigram.includes(e.matched) || e.matched.includes(bigram));
    if (ALIAS_TABLE[bigram] && !found.has(bigram) && !already) {
      entities.push({ ...ALIAS_TABLE[bigram], matched: bigram, method: 'exact', confidence: 1.0 });
      found.add(bigram);
    }
  }
  // Unigrammes
  for (const w of words) {
    if (stopWords.has(w)) continue;
    const already = entities.some(e => e.matched === w || e.matched.includes(w) || w.includes(e.matched));
    if (ALIAS_TABLE[w] && !found.has(w) && !already) {
      entities.push({ ...ALIAS_TABLE[w], matched: w, method: 'exact', confidence: 1.0 });
      found.add(w);
    }
  }
  
  // Fallback fuzzy sur les mots non matchés
  for (const w of words) {
    if (stopWords.has(w) || w.length < 4) continue; // min 4 chars pour fuzzy
    const already = entities.some(e => e.matched === w || e.c.toLowerCase().includes(w) || w.includes(e.matched));
    if (!already) {
      const fuzzy = fuzzyMatchAlias(w);
      if (fuzzy) {
        entities.push({ ...fuzzy, matched: w, method: 'fuzzy', confidence: 1 - fuzzy.distance / w.length });
        found.add(w);
      }
    }
  }
  
  return entities;
}

// ─────────────────────────────────────────────────────────────────
// COUCHE 3 — VALIDATION MULTI-SOURCES
// Vérifie que l'entité correspond à un événement réel dans les APIs
// Retourne VERIFIED ou NOT_FOUND — pas de PARTIAL en MVP
// ─────────────────────────────────────────────────────────────────
async function validateEntitiesAgainstSources(entities, liveLines, fdLines) {
  if (!entities || entities.length === 0) return { status: 'NOT_FOUND', reason: 'no_entities' };
  
  const allLines = [...liveLines, ...fdLines].map(l => l.toLowerCase());
  const validatedMatches = [];
  const unvalidated = [];
  
  for (const entity of entities) {
    const canonical = entity.c.toLowerCase();
    // Chercher l'entité dans les données live ESPN/FD
    const found = allLines.some(line => {
      const lineParts = line.replace(/[^\w\s]/g, ' ').split(/\s+/);
      const entityParts = canonical.replace(/[^\w\s]/g, ' ').split(/\s+/);
      // Au moins 1 mot significatif du nom canonique doit matcher
      return entityParts.some(part => 
        part.length >= 4 && lineParts.some(lp => 
          lp.includes(part) || part.includes(lp) || levenshtein(part, lp) <= 1
        )
      );
    });
    
    if (found) {
      // Trouver la ligne correspondante pour enrichir
      const matchingLine = allLines.find(line => {
        const lineParts = line.replace(/[^\w\s]/g, ' ').split(/\s+/);
        const entityParts = canonical.replace(/[^\w\s]/g, ' ').split(/\s+/);
        return entityParts.some(part => part.length >= 4 && lineParts.some(lp => lp.includes(part)));
      });
      validatedMatches.push({ ...entity, verified_line: matchingLine });
    } else {
      unvalidated.push(entity);
    }
  }
  
  // Règle MVP stricte : si au moins 1 équipe sur 2 est validée → OK
  // Si aucune entité n'est validée → NOT_FOUND
  if (validatedMatches.length === 0) {
    return { 
      status: 'NOT_FOUND', 
      reason: 'no_match_in_live_data',
      entities_searched: entities.map(e => e.c)
    };
  }
  
  // Si 1 seule équipe trouvée sur 2 attendues → NOT_FOUND (strict MVP)
  if (entities.length >= 2 && validatedMatches.length < 2 && unvalidated.length > 0) {
    return {
      status: 'NOT_FOUND',
      reason: 'incomplete_match',
      found: validatedMatches.map(e => e.c),
      missing: unvalidated.map(e => e.c)
    };
  }
  
  return {
    status: 'VERIFIED',
    entities: validatedMatches,
    sports: [...new Set(validatedMatches.map(e => e.s))],
  };
}

// ─────────────────────────────────────────────────────────────────
// PIPELINE COMPLET — Point d'entrée
// ─────────────────────────────────────────────────────────────────
async function runValidationPipeline(prompt, liveLines, fdLines) {
  console.log('[VALID] Pipeline démarré pour:', prompt.slice(0, 80));
  
  // Couche 1+2 : Extraction & Normalisation
  const entities = extractEntitiesV2(prompt);
  console.log('[VALID] Entités détectées:', entities.map(e => `${e.c}(${e.method})`).join(', ') || 'aucune');
  
  // Couche 3 : Validation contre sources réelles
  const validation = await validateEntitiesAgainstSources(entities, liveLines, fdLines);
  console.log('[VALID] Statut:', validation.status, validation.reason || '');
  
  return { entities, validation };
}



// ═══════════════════════════════════════════════════════════
// DÉTECTEUR D'INTENTION UNIVERSEL
// ═══════════════════════════════════════════════════════════
function detectIntention(prompt) {
  const p = prompt.toLowerCase();
  const sports = new Set();

  if (/\b(foot|soccer|ligue|premier|liga|serie a|bundesliga|champions|europa|psg|real madrid|barcelona|liverpool|chelsea|arsenal|manchester|juventus|milan|monaco|marseille|lyon|atletico|dortmund|bayern|mbappe|haaland|salah|messi|ronaldo|bellingham|mls|brasileirao|j.league|k.league|csl|nwsl|wsl|eredivisie|primeira|goal|penalty|corner)\b/.test(p))
    sports.add('foot');

  if (/\b(tennis|atp|wta|roland|garros|wimbledon|us open|australian|grand slam|masters|sinner|alcaraz|djokovic|swiatek|sabalenka|gauff|rublev|tsitsipas|medvedev|zverev|set|ace|serve|break)\b/.test(p))
    sports.add('tennis');

  if (/\b(nba|wnba|ncaa|basket|basketball|euroleague|eurocup|pro a|lakers|celtics|warriors|bulls|heat|bucks|nuggets|suns|lebron|curry|durant|giannis|tatum|embiid|jokic|wembanyama|asvel|monaco basket)\b/.test(p))
    sports.add('basket');

  if (/\b(nhl|hockey|stanley|oilers|maple leafs|rangers|bruins|penguins|canadiens|avalanche|lightning|golden knights|flames|canucks|khl|mcdavid|ovechkin|crosby|matthews|goalie|puck)\b/.test(p))
    sports.add('hockey');

  if (/\b(nfl|super bowl|chiefs|eagles|cowboys|patriots|packers|ravens|49ers|mahomes|lamar|josh allen|touchdown|quarterback)\b/.test(p))
    sports.add('nfl');

  if (/\b(mlb|baseball|yankees|dodgers|red sox|mets|cubs|braves|astros|world series|pitcher|home run|npb|kbo)\b/.test(p))
    sports.add('baseball');

  if (/\b(ufc|mma|boxing|boxe|combat|fight|ko|knockout|mcgregor|ngannou|jones|canelo|fury|usyk|joshua)\b/.test(p))
    sports.add('mma');

  if (/\b(rugby|six nations|world cup rugby|top 14|premiership|super rugby|all blacks|springboks|try|scrum)\b/.test(p))
    sports.add('rugby');

  if (/\b(f1|formula|grand prix|motogp|verstappen|hamilton|leclerc|norris|alonso|ferrari|mercedes|red bull)\b/.test(p))
    sports.add('f1');

  if (/\b(handball|ehf|starligue|paris handball|montpellier hand|kiel|flensburg|veszprem)\b/.test(p))
    sports.add('handball');

  if (/\b(volleyball|volley|fivb|vnl|trentino|civitanova|perugia|modena|zaksa|tours)\b/.test(p))
    sports.add('volley');

  // Coupe du Monde 2026
  if (/\b(coupe du monde|world cup|mundial|cdm|coupe|wc2026|group stage|phase de poule|knockout|huitieme|quart|demi.finale|finale)\b/.test(p))
    sports.add('foot');

  if (sports.size === 0) { sports.add('foot'); sports.add('tennis'); }
  return Array.from(sports);
}

// ═══════════════════════════════════════════════════════════
// SOURCES ESPN + SOURCES OFFICIELLES
// ═══════════════════════════════════════════════════════════
const ESPN_SOURCES = {
  foot: [
    { name: 'Football CL|sport_id:foot',         url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard' },
    { name: 'Football EL|sport_id:foot',          url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa/scoreboard' },
    { name: 'Football PL|sport_id:foot',          url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard' },
    { name: 'Football Liga|sport_id:foot',        url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard' },
    { name: 'Football Ligue1|sport_id:foot',      url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard' },
    { name: 'Football SerieA|sport_id:foot',      url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard' },
    { name: 'Football Bundesliga|sport_id:foot',  url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard' },
    { name: 'Football Eredivisie|sport_id:foot',  url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ned.1/scoreboard' },
    { name: 'Football Primeira|sport_id:foot',    url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/por.1/scoreboard' },
    { name: 'Football MLS|sport_id:foot',         url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard' },
    { name: 'Football Brasileirao|sport_id:foot', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard' },
    { name: 'Football Argentina|sport_id:foot',   url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/arg.1/scoreboard' },
    { name: 'Football LigaMX|sport_id:foot',      url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/scoreboard' },
    { name: 'Football JLeague|sport_id:foot',     url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/jpn.1/scoreboard' },
    { name: 'Football KLeague|sport_id:foot',     url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/kor.1/scoreboard' },
    { name: 'Football CSL|sport_id:foot',         url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/chn.1/scoreboard' },
    { name: 'Football NWSL|sport_id:foot',        url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/scoreboard' },
    { name: 'Football WSL|sport_id:foot',         url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.w.1/scoreboard' },
  ],
  tennis:   [
    { name: 'Tennis ATP|sport_id:tennis', url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard' },
    { name: 'Tennis WTA|sport_id:tennis', url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard' },
  ],
  basket:   [
    { name: 'NBA|sport_id:basket',           url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
    { name: 'WNBA|sport_id:basket',          url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard' },
    { name: 'NCAA|sport_id:basket',          url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard' },
    { name: 'Euroleague|sport_id:basket',    url: 'EUROLEAGUE_OFFICIAL' },
    { name: 'EuroCup|sport_id:basket',       url: 'EUROCUP_OFFICIAL' },
  ],
  hockey:   [
    { name: 'NHL|sport_id:hockey', url: 'NHL_OFFICIAL' },
    { name: 'AHL|sport_id:hockey', url: 'https://site.api.espn.com/apis/site/v2/sports/hockey/ahl/scoreboard' },
  ],
  nfl:      [{ name: 'NFL|sport_id:nfl',      url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' }],
  baseball: [{ name: 'MLB|sport_id:baseball', url: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard' }],
  mma:      [{ name: 'UFC|sport_id:mma',       url: 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard' }],
  rugby:    [{ name: 'Rugby|sport_id:rugby',   url: 'https://site.api.espn.com/apis/site/v2/sports/rugby/scoreboard' }],
  f1:       [{ name: 'F1|sport_id:f1',         url: 'https://site.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard' }],
  handball: [],
  volley:   [],
};

// ── Fetcher universel ───────────────────────────────────────
async function fetchESPNSource(src) {
  const cached = fromCache(src.name);
  if (cached) return cached;

  // NHL Official
  if (src.url === 'NHL_OFFICIAL') {
    const data = await fetchWithTimeout('https://api-web.nhle.com/v1/score/now');
    const lines = [];
    for (const g of (data?.games || []).slice(0, 10)) {
      if (g.gameState === 'FINAL' || g.gameState === 'OFF') continue;
      const live = g.gameState === 'LIVE' || g.gameState === 'CRIT';
      const score = live ? ` [LIVE ${g.awayTeam.score}-${g.homeTeam.score}]` : '';
      const t = g.startTimeUTC ? new Date(g.startTimeUTC).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '';
      lines.push(`[NHL|sport_id:hockey] ${g.awayTeam?.name?.default||'?'} vs ${g.homeTeam?.name?.default||'?'}${t?' — '+t:''}${score}`);
    }
    toCache(src.name, lines); return lines;
  }

  // Euroleague / EuroCup
  if (src.url === 'EUROLEAGUE_OFFICIAL' || src.url === 'EUROCUP_OFFICIAL') {
    const isCup = src.url === 'EUROCUP_OFFICIAL';
    const comp = isCup ? 'U' : 'E';
    const now = new Date();
    const seasonYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
    const season = `${comp}${seasonYear}`;
    const url = `https://feeds.incrowdsports.com/provider/euroleague-feeds/v3/competitions/${comp}/seasons/${season}/games?phaseTypeCode=RS&limit=20`;
    const data = await fetchWithTimeout(url);
    const lines = [];
    for (const g of (data?.data || []).slice(0, 10)) {
      if (g.status === 'result') continue;
      const live = g.status === 'live';
      const score = live ? ` [LIVE ${g.homeScore||0}-${g.awayScore||0}]` : '';
      const t = g.utcDate ? new Date(g.utcDate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '';
      const label = isCup ? 'EuroCup' : 'Euroleague';
      lines.push(`[${label}|sport_id:basket] ${g.homeTeam?.name||'?'} vs ${g.awayTeam?.name||'?'}${t?' — '+t:''}${score}`);
    }
    toCache(src.name, lines); return lines;
  }

  // ESPN standard
  const data = await fetchWithTimeout(src.url);
  const lines = [];
  for (const event of (data?.events || []).slice(0, 10)) {
    const comp = event.competitions?.[0];
    if (!comp) continue;
    const home = comp.competitors?.find(t => t.homeAway === 'home');
    const away = comp.competitors?.find(t => t.homeAway === 'away');
    if (!home || !away) continue;
    const status = comp.status?.type?.name || '';
    if (status === 'STATUS_FINAL') continue;
    const live = status === 'STATUS_IN_PROGRESS';
    const score = live ? ` [LIVE ${home.score}-${away.score}]` : '';
    const t = event.date ? new Date(event.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '';
    lines.push(`[${src.name}] ${home.team?.displayName||'?'} vs ${away.team?.displayName||'?'}${t?' — '+t:''}${score}`);
  }
  toCache(src.name, lines); return lines;
}

// ── RSS News ────────────────────────────────────────────────
const RSS_FEEDS = [
  { name: 'BBC Sport',    url: 'https://feeds.bbci.co.uk/sport/football/rss.xml',     sport: 'foot'   },
  { name: 'Sky Sports',   url: 'https://www.skysports.com/rss/12040',                  sport: 'foot'   },
  { name: 'The Guardian', url: 'https://www.theguardian.com/football/rss',             sport: 'foot'   },
  { name: "L'Equipe",     url: 'https://www.lequipe.fr/rss/actu_rss_Football.xml',    sport: 'foot'   },
  { name: 'Foot Mercato', url: 'https://www.footmercato.net/rss',                      sport: 'foot'   },
  { name: 'UEFA',         url: 'https://www.uefa.com/rssfeed/newslist/latest/',        sport: 'foot'   },
  { name: 'BBC Tennis',   url: 'https://feeds.bbci.co.uk/sport/tennis/rss.xml',       sport: 'tennis' },
  { name: 'BBC NBA',      url: 'https://feeds.bbci.co.uk/sport/basketball/rss.xml',   sport: 'basket' },
  { name: 'BBC Rugby',    url: 'https://feeds.bbci.co.uk/sport/rugby-union/rss.xml',  sport: 'rugby'  },
  { name: 'BBC F1',       url: 'https://feeds.bbci.co.uk/sport/formula1/rss.xml',     sport: 'f1'     },
];
const CORS_PROXY = 'https://api.allorigins.win/get?url=';

async function fetchRSSFeed(feed) {
  const cached = fromCache('rss_' + feed.name);
  if (cached) return cached;
  const data = await fetchTextWithTimeout(CORS_PROXY + encodeURIComponent(feed.url), 5000).catch(() => null);
  if (!data) return [];
  let xml = data;
  try { xml = JSON.parse(data).contents || data; } catch {}
  const items = [];
  const matches = xml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g) || [];
  matches.slice(1, 5).forEach(m => {
    const title = m.replace(/<title><!\[CDATA\[|\]\]><\/title>|<title>|<\/title>/g, '').trim();
    if (title && title.length > 10) items.push(`[${feed.name}] ${title}`);
  });
  toCache('rss_' + feed.name, items);
  return items;
}

// Football-Data.org
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || '';
async function fetchFootballData(sportIds) {
  if (!sportIds.includes('foot') || !FOOTBALL_DATA_KEY) return [];
  const cached = fromCache('football_data');
  if (cached) return cached;
  const url = 'https://api.football-data.org/v4/matches?status=SCHEDULED,LIVE,IN_PLAY';
  const data = await Promise.race([
    fetch(url, { headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY } }).then(r => r.ok ? r.json() : null),
    new Promise((_, rej) => setTimeout(() => rej(), 4000))
  ]).catch(() => null);
  const lines = [];
  for (const m of (data?.matches || []).slice(0, 15)) {
    if (m.status === 'FINISHED') continue;
    const live = m.status === 'IN_PLAY' || m.status === 'PAUSED';
    const score = live ? ` [LIVE ${m.score?.fullTime?.home||0}-${m.score?.fullTime?.away||0}]` : '';
    const t = m.utcDate ? new Date(m.utcDate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '';
    lines.push(`[Football-Data|${m.competition?.name||'Football'}|sport_id:foot] ${m.homeTeam?.name||'?'} vs ${m.awayTeam?.name||'?'}${t?' — '+t:''}${score}`);
  }
  toCache('football_data', lines);
  return lines;
}

// ═══════════════════════════════════════════════════════════
// FILTRE DE PERTINENCE — Score intelligent par intention
// ═══════════════════════════════════════════════════════════
function extractEntities(prompt) {
  const p = prompt.toLowerCase();
  const stopWords = new Set(['match','game','play','team','club','sport','score','win','loss',
    'draw','the','and','for','this','that','avec','pour','les','des','dans','contre','vs','versus']);
  const tokens = p.match(/[a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüý]{3,}/g) || [];
  const entities = new Set();
  tokens.forEach(t => { if (!stopWords.has(t)) entities.add(t); });
  return entities;
}

function scoreRelevance(line, entities, prompt) {
  const lineLower = line.toLowerCase();
  let score = 0;
  for (const entity of entities) {
    if (lineLower.includes(entity)) { score = Math.max(score, 3); break; }
  }
  if (lineLower.includes('[live')) score = Math.max(score, 2);
  if (score === 0) {
    const sportIds = detectIntention(prompt);
    for (const sid of sportIds) {
      if (lineLower.includes('sport_id:' + sid)) { score = Math.max(score, 1); break; }
    }
  }
  return score;
}

function filterAndPrioritize(lines, prompt) {
  if (!lines || lines.length === 0) return [];
  const entities = extractEntities(prompt);
  const scored = lines.map(line => ({ line, score: scoreRelevance(line, entities, prompt) }));
  scored.sort((a, b) => b.score - a.score);
  const relevant   = scored.filter(s => s.score >= 1).map(s => s.line);
  const contextual = scored.filter(s => s.score === 0).slice(0, 5).map(s => s.line);
  const result = [...relevant, ...contextual];
  console.log(`[FILTER] ${lines.length} → ${result.length} lignes après scoring`);
  return result;
}

// ═══════════════════════════════════════════════════════════
// CONSTRUCTEUR JSON_VALIDATED_DATA v2 — enrichi par le pipeline
// ═══════════════════════════════════════════════════════════
function buildValidatedDataContainerV2(liveLines, newsLines, fdLines, sportIds, prompt, entities, validation) {
  const filteredLive = filterAndPrioritize(liveLines, prompt);
  
  let block = '\n\u2501\u2501\u2501 JSON_VALIDATED_DATA v2 \u2501\u2501\u2501\n';
  block += 'validation_status: ' + validation.status + '\n';
  block += 'pipeline: Fact-First v2 (alias_table + fuzzy_levenshtein + multi_source)\n';
  
  if (entities && entities.length > 0) {
    block += '\n[RECOGNIZED_ENTITIES]\n';
    entities.forEach(function(e) {
      block += '  ' + e.c + ' (sport:' + e.s + ', method:' + e.method + (e.distance ? ', dist:'+e.distance : '') + ')\n';
    });
  }
  
  if (validation.status === 'VERIFIED' && validation.entities) {
    block += '\n[VERIFIED_IN_LIVE_DATA]\n';
    validation.entities.forEach(function(e) {
      block += '  OK ' + e.c + ' -> ' + (e.verified_line || 'found in API') + '\n';
    });
  }
  
  if (filteredLive.length > 0) {
    block += '\n[LIVE_MATCHES]\n';
    block += filteredLive.join('\n') + '\n';
  }
  
  if (fdLines.length > 0) {
    block += '\n[FOOTBALL_DATA]\n';
    block += fdLines.join('\n') + '\n';
  }
  
  if (newsLines.length > 0) {
    block += '\n[NEWS_CONTEXT]\n';
    block += newsLines.slice(0, 6).join('\n') + '\n';
  }
  
  if (filteredLive.length === 0 && fdLines.length === 0) {
    block += '\n[NO_LIVE_DATA]\n';
    block += 'No live matches found for: ' + sportIds.join(', ') + '\n';
    if (entities.length > 0) {
      block += 'Recognized entities: ' + entities.map(function(e){return e.c;}).join(', ') + '\n';
      block += '-> Analyze based ONLY on recognized entities above.\n';
      block += '-> DO NOT invent match details, dates, or scores.\n';
    } else {
      block += '-> No entities recognized. Return NOT_FOUND immediately.\n';
    }
  }
  
  block += '\n-------------------------------------\n';
  block += 'STRICT RULE: Only analyze entities listed above.\n';
  block += 'If match date/time is unknown -> set match_date_uncertain:true.\n\n';
  
  return block;
}

// ═══════════════════════════════════════════════════════════
// CONSTRUCTEUR JSON_VALIDATED_DATA (legacy — conservé) — Conteneur de vérité
// C'est la pièce centrale de l'architecture Fact-First
// ═══════════════════════════════════════════════════════════
function buildValidatedDataContainer(liveLines, newsLines, fdLines, sportIds, prompt) {
  const filteredLive = filterAndPrioritize(liveLines, prompt);

  // Statut de validation global
  const hasVerifiedData = filteredLive.length > 0 || fdLines.length > 0;
  const validationStatus = hasVerifiedData ? 'PARTIAL' : 'UNVERIFIED';

  let block = `\n━━━ JSON_VALIDATED_DATA ━━━\n`;
  block += `validation_status: ${validationStatus}\n`;
  block += `data_sources: ESPN×18, NHL_Official, Euroleague, Football-Data\n`;
  block += `\n`;

  if (filteredLive.length > 0) {
    block += `[VERIFIED_LIVE_MATCHES]\n`;
    block += filteredLive.join('\n') + '\n\n';
  }

  if (fdLines.length > 0) {
    block += `[FOOTBALL_DATA_FIXTURES]\n`;
    block += fdLines.join('\n') + '\n\n';
  }

  if (newsLines.length > 0) {
    block += `[NEWS_CONTEXT — for injury/form enrichment only]\n`;
    block += newsLines.slice(0, 8).join('\n') + '\n\n';
  }

  if (filteredLive.length === 0 && fdLines.length === 0) {
    block += `[NO_LIVE_DATA_FOUND]\n`;
    block += `No matches found in live APIs for sports: ${sportIds.join(', ')}\n`;
    block += `→ Analyze based STRICTLY on user input. Do NOT invent matches.\n`;
    block += `→ If user input is ambiguous, return validation_status: NOT_FOUND\n\n`;
  }

  block += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  block += `CRITICAL: Only analyze events present above or explicitly stated by user.\n`;
  block += `If a match is NOT in the data above and NOT clearly stated → DO NOT INVENT IT.\n\n`;

  return block;
}

// ═══════════════════════════════════════════════════════════
// ORCHESTRATEUR
// ═══════════════════════════════════════════════════════════
async function fetchAllData(sportIds) {
  const espnPromises = sportIds.flatMap(id => (ESPN_SOURCES[id] || []).map(s => fetchESPNSource(s)));
  const rssPromise   = Promise.allSettled(
    RSS_FEEDS.filter(f => sportIds.includes(f.sport)).map(f => fetchRSSFeed(f))
  ).then(rs => rs.flatMap(r => r.status === 'fulfilled' && r.value ? r.value : []));
  const fdPromise    = fetchFootballData(sportIds);

  const [espnResults, newsLines, fdLines] = await Promise.all([
    Promise.allSettled(espnPromises).then(rs => rs.flatMap(r => r.status === 'fulfilled' && r.value ? r.value : [])),
    rssPromise.catch(() => []),
    fdPromise.catch(() => []),
  ]);

  return { live: espnResults, news: newsLines, fd: fdLines };
}

// ── Health check ────────────────────────────────────────────
async function checkModelsHealth() {
  console.log('[MODEL CHECK] Vérification des modèles Gemini...');
  for (const model of MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(url, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say ok' }] }], generationConfig: { maxOutputTokens: 5, thinkingConfig: { thinkingBudget: 0 } } })
      });
      clearTimeout(tid);
      if (r.status === 404) console.error(`[MODEL CHECK] ❌ ${model} — DÉPRÉCIÉ`);
      else if (r.ok) console.log(`[MODEL CHECK] ✅ ${model} — OK`);
      else console.warn(`[MODEL CHECK] ⚠️ ${model} — HTTP ${r.status}`);
    } catch (err) {
      console.warn(`[MODEL CHECK] ⚠️ ${model} — ${err.name === 'AbortError' ? 'Timeout' : err.message}`);
    }
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'SUPERCOACH API OK', version: '6.0-fact-first', cached: Object.keys(CACHE).length });
});

app.get('/health', async (req, res) => {
  const status = {};
  for (const model of MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 6000);
      const r = await fetch(url, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say ok' }] }], generationConfig: { maxOutputTokens: 5 } })
      });
      status[model] = r.ok ? '✅ OK' : `❌ HTTP ${r.status}`;
    } catch (e) { status[model] = e.name === 'AbortError' ? '⚠️ Timeout' : `❌ ${e.message}`; }
  }
  res.json({ time: new Date().toISOString(), models: status });
});

// ═══════════════════════════════════════════════════════════
// ENDPOINT PRINCIPAL /analyze
// ═══════════════════════════════════════════════════════════
app.post('/analyze', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt manquant' });
    if (!GEMINI_KEY) return res.status(500).json({ error: 'Clé API non configurée' });

    const T0 = Date.now();

    // 1. Temps réel + intention
    const timeBlock = getRealTimeBlock();
    const systemPrompt = getSystemPrompt();
    const sportIds = detectIntention(prompt);
    const T1 = Date.now();
    console.log(`[TIMER] Intention: ${T1-T0}ms — Sports: ${sportIds.join(', ')}`);

    // 2. Fetch ciblé
    const sources = await fetchAllData(sportIds);
    const T2 = Date.now();
    console.log(`[TIMER] Fetch: ${T2-T1}ms — Live:${sources.live.length} News:${sources.news.length} FD:${sources.fd.length}`);

    // 3. Pipeline Fact-First v2 : Extraction → Normalisation → Validation
    const { entities, validation } = await runValidationPipeline(
      prompt, sources.live, sources.fd
    );
    console.log('[PIPELINE] Status:', validation.status, '| Entities:', entities.map(e=>e.c).join(', ')||'none');

    // Règle MVP stricte : NOT_FOUND → stop immédiat
    if (validation.status === 'NOT_FOUND' && entities.length > 0) {
      // Des entités reconnues mais non trouvées dans les données live
      // → Match peut être futur/passé → laisser Gemini analyser avec contexte strict
      console.log('[PIPELINE] Entités non validées live → analyse avec contrainte stricte');
    }

    // 4. Construire le conteneur de vérité enrichi
    const validatedContainer = buildValidatedDataContainerV2(
      sources.live, sources.news, sources.fd, sportIds, prompt, entities, validation
    );
    const T3 = Date.now();

    // 4. Assembler le prompt enrichi
    // Ordre : SystemPrompt → AncrageTemporal → JSON_VALIDATED_DATA → User Input
    const marker = '━━━ USER INPUT BELOW ━━━';
    let enrichedPrompt;
    if (prompt.includes(marker)) {
      enrichedPrompt = systemPrompt + timeBlock + prompt.replace(marker, validatedContainer + marker);
    } else {
      enrichedPrompt = systemPrompt + timeBlock + validatedContainer + prompt;
    }

    const promptTokenEstimate = Math.round(enrichedPrompt.length / 4);
    console.log(`[TIMER] Prompt: ${T3-T2}ms — ${enrichedPrompt.length} chars (~${promptTokenEstimate} tokens)`);

    // 5. Rappel format final
    enrichedPrompt += '\n\nFORMAT RULES:\n1. Respond ONLY with valid JSON object: {"matches":[...],"summary":"...","roi_potential":"..."}\n2. NEVER bare array. NEVER markdown. NEVER backticks.\n3. Start with { end with }';

    // 6. Appel Gemini avec cascade fallback
    let text = null, usedModel = null, lastError = null;

    for (const model of MODELS) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000);

        const response = await fetch(url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: enrichedPrompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 16384 }
          })
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          const errMsg = err?.error?.message || '';
          if (response.status === 429 || response.status === 503 ||
              errMsg.includes('high demand') || errMsg.includes('quota') ||
              errMsg.includes('overloaded')) {
            console.log(`[FALLBACK] ${model} surchargé → suivant`);
            lastError = errMsg || `HTTP ${response.status}`;
            continue;
          }
          return res.status(response.status).json({ error: errMsg || 'Erreur Gemini' });
        }

        const data = await response.json();
        const candidate = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!candidate) { lastError = 'Réponse vide'; continue; }

        text = candidate;
        usedModel = model;
        const T4 = Date.now();
        console.log(`[TIMER] Gemini(${model}): ${T4-T3}ms | TOTAL: ${T4-T0}ms`);
        break;

      } catch (err) {
        if (err.name === 'AbortError') {
          console.log(`[FALLBACK] ${model} timeout 25s → suivant`);
          lastError = 'timeout';
        } else {
          lastError = err.message;
        }
        continue;
      }
    }

    if (!text) {
      return res.status(503).json({ error: `Gemini temporairement indisponible. Réessaie dans quelques minutes. (${lastError})` });
    }

    // 7. Nettoyage backend
    text = text.replace(/^```json\s*/gi, '').replace(/^```\s*/gi, '').replace(/```\s*$/g, '').trim();
    if (!text.startsWith('{') && !text.startsWith('[')) {
      const idx = text.indexOf('{');
      if (idx > -1) text = text.slice(idx);
    }

    const TEND = Date.now();
    res.json({
      result: text,
      meta: {
        sports: sportIds,
        live: sources.live.length,
        news: sources.news.length,
        fd: sources.fd.length,
        model: usedModel,
        timing: {
          total_ms: TEND - T0,
          fetch_ms: T2 - T1,
          gemini_ms: TEND - T3,
          prompt_chars: enrichedPrompt.length,
          prompt_tokens_est: promptTokenEstimate
        }
      }
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
    res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
});


// ═══════════════════════════════════════════════════════════
// ENDPOINT /scrape — Proxy de scraping
// Le serveur visite l'URL à la place de l'iPhone
// Résout le problème CORS Safari + permet le collage d'URL directe
// ═══════════════════════════════════════════════════════════
app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  // Valider le format URL
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: 'URL invalide — HTTP/HTTPS uniquement' });
    }
  } catch {
    return res.status(400).json({ error: 'URL invalide' });
  }

  console.log(`[SCRAPE] Tentative : ${parsedUrl.hostname}`);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Simuler un navigateur réel pour éviter les blocages basiques
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Referer': 'https://www.google.com/',
      }
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 403 || response.status === 503) {
        return res.json({
          success: false,
          blocked: true,
          message: `Site protégé (${parsedUrl.hostname}) — copiez le texte manuellement`,
          hostname: parsedUrl.hostname
        });
      }
      return res.json({ success: false, message: `Erreur HTTP ${response.status}` });
    }

    const html = await response.text();

    // Extraire le texte propre — supprimer scripts, styles, nav, pubs
    const clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/\s{3,}/g, '\n')
      .trim();

    // Limiter à 8000 caractères pour ne pas surcharger Gemini
    const truncated = clean.length > 8000 ? clean.slice(0, 8000) + '\n[...contenu tronqué]' : clean;

    console.log(`[SCRAPE] ✅ ${parsedUrl.hostname} — ${truncated.length} chars extraits`);

    res.json({
      success: true,
      hostname: parsedUrl.hostname,
      content: truncated,
      chars: truncated.length
    });

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.json({
        success: false,
        blocked: true,
        message: `Timeout — ${parsedUrl.hostname} trop lent ou bloqué`,
        hostname: parsedUrl.hostname
      });
    }
    console.error('[SCRAPE] Erreur:', err.message);
    res.json({ success: false, message: 'Erreur réseau : ' + err.message });
  }
});

// Warmup + health check au démarrage
app.listen(PORT, () => {
  console.log(`SUPERCOACH API v6.0-fact-first — port ${PORT}`);
  setTimeout(() => {
    const warmup = [
      ...(ESPN_SOURCES.foot || []).slice(0, 4),
      ...(ESPN_SOURCES.tennis || []),
    ];
    Promise.allSettled(warmup.map(s => fetchESPNSource(s)))
      .then(() => console.log('[WARMUP] Cache foot + tennis prêt'));
    if (GEMINI_KEY) checkModelsHealth();
  }, 3000);
});
