/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { 
  Plus, 
  Menu,
  Search, 
  Upload, 
  BookOpen, 
  CheckCircle2, 
  AlertCircle, 
  XCircle, 
  ChevronRight,
  ChevronDown,
  FileText,
  Grid2X2,
  X,
  Volume2,
  Book,
  Languages,
  RotateCcw,
  Loader2,
  Sparkles,
  LogIn,
  LogOut,
  User as UserIcon,
  Cloud,
  CloudOff,
  Download,
  RefreshCw,
  Trash2,
  Keyboard,
  Edit2,
  BarChart3,
  Zap
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Word, ReviewGrade } from './types';
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { auth, db, googleProvider } from './lib/firebase';
import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import { doc, setDoc, getDoc, onSnapshot } from 'firebase/firestore';
// Heavy file-parsing libraries (xlsx, mammoth, pdfjs-dist) are lazy-loaded in handleFileUpload

const STORAGE_KEY = 'mon_francais_vocab';
// Strict day ladder: a new word is first shown ~10 minutes after being added (learning step),
// then each successful review advances: 1d -> 3d -> 7d -> 14d -> 30d -> mastered (maintenance 60/120/240/365d).
// REVIEW_INTERVALS[review_count] = days until the next review after the (count+1)-th success.
const REVIEW_INTERVALS = [1, 3, 7, 14, 30];
const NEW_WORD_FIRST_DELAY = 10 * 60 * 1000; // learning step: first review 10 min after adding
const DAILY_REVIEW_LIMIT = 50; // Max cards per day
const DAILY_NEW_LIMIT = 15;    // Max brand-new words introduced per day
const EXERCISE_SESSION_SIZE = 15; // Words per session in reverse practice / quiz / match / typing
const COMPOSE_SESSION_SIZE = 15;      // Words per standalone compose-a-sentence session
const COMPOSE_COMBO_SESSION_SIZE = 5; // Shorter leg inside the full combo session

// Exercise words are organized into 3 tiers mirroring flashcard grades.
// A word graduates one tier on a correct exercise answer, and repeats within
// its tier (or demotes) on a wrong one. See partitionIntoBuckets/pullFromBuckets/resolveExerciseAnswer.
type ExTier = 'forgotten' | 'almost' | 'remembered';
type ExBuckets = Record<ExTier, Word[]>;
const EMPTY_BUCKETS: ExBuckets = { forgotten: [], almost: [], remembered: [] };

const FALLBACK_MODELS = [
  "gemini-3.1-flash-lite",
  "gemma-4-26b-a4b-it",
  "gemini-2.5-flash-lite",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
];

async function generateWithFallback(ai: any, params: any): Promise<any> {
  let lastError: any;
  for (const model of FALLBACK_MODELS) {
    try {
      const response = await ai.models.generateContent({ ...params, model });
      return response;
    } catch (err: any) {
      const code = (() => { try { return JSON.parse(err.message)?.error?.code; } catch { return null; } })();
      if (code === 429 || code === 503 || code === 500) {
        lastError = err;
        continue; // try next model
      }
      throw err; // other errors — stop immediately
    }
  }
  throw lastError;
}

function extractJson(response: any): string {
  const parts = response?.candidates?.[0]?.content?.parts;
  let text = '';
  if (parts) {
    text = parts.filter((p: any) => !p.thought).map((p: any) => p.text || '').join('');
  }
  if (!text) text = response?.text || '';
  // Strip markdown code blocks
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();
  // Extract first JSON object or array
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) return jsonMatch[1];
  return text;
}

export default function App() {
  // Refs declared at the very top so exercise functions can reliably access them
  const batchWrongWordIds = React.useRef<Set<string>>(new Set());
  const matchWrongWordIds = React.useRef<Set<string>>(new Set());
  // Which tier each in-flight word was pulled from, keyed by word id
  const currentExerciseBatchTiers = React.useRef<Record<string, ExTier>>({});
  const matchPoolTiers = React.useRef<Record<string, ExTier>>({});
  // Words already shown in the CURRENT single-word session — a wrong answer requeues the word
  // in its bucket, but it must not reappear within the same session
  const sessionSeenIds = React.useRef<Set<string>>(new Set());

  const [user, setUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [words, setWords] = useState<Word[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [showAccents, setShowAccents] = useState(false);
  const [targetLanguage, setTargetLanguage] = useState(() => localStorage.getItem('target_language') || 'Russe');
  const [isTranslatingLibrary, setIsTranslatingLibrary] = useState(false);
  const [isTranslationPromptOpen, setIsTranslationPromptOpen] = useState(false);
  const [pendingTargetLang, setPendingTargetLang] = useState<string | null>(null);

  const languages = [
    { id: 'Russe', name: 'Russe', flag: '🇷🇺', aiName: 'Russian' },
    { id: 'Anglais', name: 'Anglais', flag: '🇬🇧', aiName: 'English' },
    { id: 'Espagnol', name: 'Espagnol', flag: '🇪🇸', aiName: 'Spanish' },
    { id: 'Allemand', name: 'Allemand', flag: '🇩🇪', aiName: 'German' },
    { id: 'Italien', name: 'Italien', flag: '🇮🇹', aiName: 'Italian' },
  ];

  const currentLangObj = languages.find(l => l.id === targetLanguage) || languages[0];

  const installGuideContent = {
    Russe: {
      title: "Установить Francabulaire",
      subtitle: "Как добавить иконку на экран",
      androidTitle: "На Android (Chrome)",
      androidDesc: <>Нажмите на <span className="font-bold">3 точки</span> в углу, затем на <span className="font-bold">"Установить приложение"</span>.</>,
      iosTitle: "На iPhone (Safari)",
      iosDesc: <>Нажмите кнопку <span className="font-bold">"Поделиться"</span> (квадрат со стрелкой), затем <span className="font-bold">"На экран Домой"</span>.</>,
      desktopTitle: "На ПК (Chrome)",
      desktopDesc: <>Нажмите иконку <span className="font-bold">"Установить"</span> в адресной строке.</>,
      button: "ПОНЯТНО"
    },
    Anglais: {
      title: "Install Francabulaire",
      subtitle: "How to add the icon to your screen",
      androidTitle: "On Android (Chrome)",
      androidDesc: <>Tap the <span className="font-bold">3 dots</span> icon, then tap <span className="font-bold">"Install app"</span>.</>,
      iosTitle: "On iPhone (Safari)",
      iosDesc: <>Tap the <span className="font-bold">"Share"</span> button, then <span className="font-bold">"Add to Home Screen"</span>.</>,
      desktopTitle: "On PC (Chrome)",
      desktopDesc: <>Click the <span className="font-bold">"Install"</span> icon in the address bar.</>,
      button: "GOT IT"
    }
  };

  const currentGuide = (installGuideContent as any)[targetLanguage] || installGuideContent.Russe;

  const generateStoryExercise = async () => {
    if (isStoryLoading) return; // guard against double click
    setIsStoryLoading(true);
    setExerciseFeedback(null);
    setUserAnswers([]);
    setWordHintIndex(null);
    batchWrongWordIds.current.clear();

    try {
      const apiKey = process.env.GEMINI_API_KEY || (window as any).GEMINI_API_KEY;
      if (!apiKey) throw new Error("Clé API не найдена.");
      const ai = new GoogleGenAI({ apiKey });

      // Merge newly-eligible words + return any previous unfinished batch to its tier — commit immediately (safe, non-destructive)
      let buckets = getOrBuildBuckets();
      if (currentExerciseBatch.length > 0) {
        const merged: ExBuckets = { forgotten: [...buckets.forgotten], almost: [...buckets.almost], remembered: [...buckets.remembered] };
        [...currentExerciseBatch].reverse().forEach(w => {
          const tier = currentExerciseBatchTiers.current[w.id] || 'almost';
          merged[tier] = [w, ...merged[tier]];
        });
        buckets = merged;
        setExerciseBuckets(buckets);
        setCurrentExerciseBatch([]);
        currentExerciseBatchTiers.current = {};
      }

      // Pull 5 words locally; only commit the removal once generation succeeds
      const { picked, rest } = pullFromBuckets(buckets, 5, { order: HARD_ORDER });
      if (picked.length < 5) {
        alert("Il vous faut au moins 5 mots révisés en mode cartes pour générer un exercice. Révisez d'abord quelques mots !");
        setIsStoryLoading(false);
        return;
      }
      const selectedWords = picked.map(p => p.word);
      const selectedTiers: Record<string, ExTier> = Object.fromEntries(picked.map(p => [p.word.id, p.tier]));

      const wordListStr = selectedWords.map(w => w.word).join(', ');

      const response = await generateWithFallback(ai, {
        contents: `Tu es un professeur de français NATIF et rigoureux. Pour chaque mot de la liste, écris UNE phrase simple et naturelle en français (niveau A2-B1) où ce mot est manquant et doit être deviné grâce au contexte.

Les phrases sont INDÉPENDANTES les unes des autres — pas besoin de les relier en histoire.
Chaque phrase doit rendre le mot manquant ÉVIDENT par le contexte (situation claire, synonyme, antonyme, explication).

Mots : ${wordListStr}

GRAMMAIRE — la phrase complète (le trou rempli par le mot exact) doit être PARFAITEMENT correcte :
- Vérifie l'élision : "l'" seulement devant voyelle ou h muet ; sinon "le"/"la" (ex : "le logea", PAS "l' logea").
- Accorde les articles, déterminants, adjectifs et participes avec le genre et le nombre du mot caché.
- Conjugue correctement les verbes ; respecte les prépositions.
- Relis chaque phrase comme si le trou était déjà rempli : elle doit sonner naturelle pour un francophone natif.
- Garde le mot caché à sa forme EXACTE telle qu'elle apparaît dans la liste (ne le décline pas, ne le conjugue pas).

Retourne UNIQUEMENT un objet JSON (sans markdown) :
{
  "title": "Complétez les phrases",
  "sentences": ["Première phrase avec {{0}}.", "Deuxième phrase avec {{1}}.", "Troisième phrase avec {{2}}."],
  "gaps": ["mot0", "mot1", "mot2"]
}

Règles importantes :
- Le marqueur {{N}} correspond exactement à gaps[N]
- Une seule phrase par mot, une seule lacune par phrase
- Le contexte autour du trou doit clairement indiquer quel mot manque
- Les phrases ne doivent PAS être liées entre elles
- Chaque phrase est un élément séparé du tableau "sentences"`,
        config: {}
      });

      const raw = extractJson(response) || '{}';
      let result: any;
      try {
        result = JSON.parse(raw);
      } catch {
        // Repair common AI JSON issues: raw newlines inside strings, trailing commas
        const repaired = raw
          .replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/\r/g, '').replace(/\n/g, '\\n'))
          .replace(/,\s*([}\]])/g, '$1');
        try { result = JSON.parse(repaired); } catch { result = {}; }
      }

      // Support both formats: "sentences" array (preferred) or legacy "story" string
      const story = Array.isArray(result.sentences) && result.sentences.length > 0
        ? result.sentences.join('\n')
        : result.story;

      if (story && Array.isArray(result.gaps) && result.gaps.length > 0) {
        // Consume the buckets only now that generation succeeded
        setExerciseBuckets(rest);
        setCurrentExerciseBatch(selectedWords);
        currentExerciseBatchTiers.current = selectedTiers;
        setGeneratedStory({
          title: result.title || 'Complétez les phrases',
          story,
          gaps: result.gaps,
          shuffledGaps: [...result.gaps].sort(() => Math.random() - 0.5)
        });
        setUserAnswers(new Array(result.gaps.length).fill(''));
      } else {
        alert("La génération a échoué, réessayez.");
      }
    } catch (error) {
      console.error("Error generating story:", error);
      alert("Erreur de génération. Vérifiez votre connexion et réessayez.");
    } finally {
      setIsStoryLoading(false);
    }
  };

  const translateLibrary = useCallback(async (newLang: string) => {
    const langObj = languages.find(l => l.id === newLang) || languages[0];
    const wordsToTranslate = words.filter(w => w.target_lang !== newLang);
    
    if (wordsToTranslate.length === 0) return;
    
    setIsTranslatingLibrary(true);
    try {
      const apiKey = process.env.GEMINI_API_KEY || (window as any).GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("Clé API introuvable.");
      }

      const ai = new GoogleGenAI({ apiKey });
      
      // Process in small batches
      const batchSize = 10;
      const updatedWords = [...words];

      for (let i = 0; i < wordsToTranslate.length; i += batchSize) {
        const batch = wordsToTranslate.slice(i, i + batchSize);
        const wordList = batch.map(w => w.word).join(', ');

        const response = await generateWithFallback(ai, {
          contents: `Translate these French words/expressions to ${langObj.aiName}: ${wordList}.
          
          Guidelines:
          1. Return ONLY a JSON object where keys are original French words and values are translations in ${langObj.aiName}.
          2. Use accurate, context-aware translations.
          3. Do not include articles in translations unless necessary for grammar in ${langObj.aiName}.`,
          config: {
              responseMimeType: "application/json",
          }
        });

        const translations = JSON.parse(extractJson(response) || '{}');
        
        batch.forEach(w => {
          const idx = updatedWords.findIndex(uw => uw.id === w.id);
          // Case-insensitive match for keys if necessary
          const translationText = translations[w.word] || translations[w.word.toLowerCase()];
          
          if (idx !== -1 && translationText) {
            updatedWords[idx] = {
              ...updatedWords[idx],
              translation: translationText,
              target_lang: newLang
            };
          }
        });

        // Add a small delay between batches to avoid rate limits
        if (i + batchSize < wordsToTranslate.length) {
          await new Promise(resolve => setTimeout(resolve, 800));
        }
      }

      setWords(updatedWords);
    } catch (error) {
      console.error("Translation library error:", error);
      setError("Désolé, une erreur est survenue lors de la traduction de votre bibliothèque.");
    } finally {
      setIsTranslatingLibrary(false);
    }
  }, [words, languages]);

  const confirmLanguageChange = (newLang: string) => {
    if (words.length > 0) {
      setPendingTargetLang(newLang);
      setIsTranslationPromptOpen(true);
    } else {
      setTargetLanguage(newLang);
    }
  };

  useEffect(() => {
    localStorage.setItem('target_language', targetLanguage);
    lastFetchedQuery.current = '';
    // Exercise buckets hold words of the previous language — reset them
    setExerciseBuckets(EMPTY_BUCKETS);
    setCurrentExerciseBatch([]);
    currentExerciseBatchTiers.current = {};
    setGeneratedStory(null);
    setExerciseFeedback(null);
    setUserAnswers([]);
  }, [targetLanguage]);

  const speak = (text: string) => {
    if (!text) return;
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'fr-FR';
    utterance.rate = 0.85;

    // Pick best French voice: prefer Google/Microsoft online voices
    const voices = window.speechSynthesis.getVoices();
    const frVoices = voices.filter(v => v.lang.startsWith('fr'));
    const preferred = frVoices.find(v => /google|microsoft|thomas|amelie|alain|claire/i.test(v.name))
      || frVoices.find(v => v.localService === false) // online voice = better quality
      || frVoices[0];
    if (preferred) utterance.voice = preferred;

    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);

    // Voices may load async on first call
    if (voices.length === 0) {
      window.speechSynthesis.onvoiceschanged = () => {
        const v2 = window.speechSynthesis.getVoices();
        const fr2 = v2.filter(v => v.lang.startsWith('fr'));
        const best = fr2.find(v => /google|microsoft|thomas|amelie|alain|claire/i.test(v.name))
          || fr2.find(v => v.localService === false) || fr2[0];
        if (best) utterance.voice = best;
        window.speechSynthesis.speak(utterance);
      };
    } else {
      window.speechSynthesis.speak(utterance);
    }
  };
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  // Collocations for the word currently shown in the dictionary — learning in context.
  // Clicking one saves the PHRASE to the base instead of the bare word.
  const [collocations, setCollocations] = useState<{ phrase: string; translation: string }[]>([]);
  const [collocationsFor, setCollocationsFor] = useState<string>('');
  const [isLoadingCollocations, setIsLoadingCollocations] = useState(false);
  const [savedCollocations, setSavedCollocations] = useState<Set<string>>(new Set());
  const pendingTranslations = React.useRef<Set<string>>(new Set());
  const lastFetchedQuery = React.useRef<string>('');

  const normalizeWord = (str: string) => 
    str.normalize("NFD")
       .replace(/[\u0300-\u036f]/g, "")
       .toLowerCase()
       .replace(/œ/g, "oe")
       .replace(/æ/g, "ae")
       .replace(/[’']/g, "'")
       .trim();
  
  const stripArticles = (str: string) => 
    str.replace(/^(le\s|la\s|les\s|l'|l’|un\s|une\s|des\s)/i, '').trim();
  
  const getWordWithArticle = (word: string, gender?: 'm' | 'f' | 'none', isPlural?: boolean) => {
    if (!gender || gender === 'none') return word;
    const trimmed = word.trim();
    const lower = trimmed.toLowerCase();
    // Don't add article to phrases (multiple words) or verb forms
    if (trimmed.includes(' ')) return word;
    const articles = ['le ', 'la ', 'les ', "l'", 'un ', 'une ', 'des '];
    if (articles.some(article => lower.startsWith(article))) return word;
    if (isPlural) return `les ${trimmed}`;
    const firstChar = lower[0];
    const isVowel = ['a', 'e', 'i', 'o', 'u', 'y', 'é', 'è', 'ê', 'ë', 'à', 'â', 'î', 'ï', 'ô', 'û', 'ù'].includes(firstChar);
    if (isVowel) return `l'${trimmed}`;
    return gender === 'm' ? `le ${trimmed}` : `la ${trimmed}`;
  };

  const cleanExample = (example?: string) => {
    if (!example) return '';
    return example.split(' (')[0].trim();
  };

  const getExampleTranslation = (word: Word) => {
    if (word.exampleTranslation) return word.exampleTranslation;
    if (word.example && word.example.includes(' (')) {
      return word.example.split(' (')[1].replace(')', '').trim();
    }
    return '';
  };

  const [isReviewing, setIsReviewing] = useState(false);
  const [reviewPaused, setReviewPaused] = useState(false);
  // Extra cards the learner explicitly asked for beyond today's limit (resets on reload)
  const [bonusCards, setBonusCards] = useState(0);
  const [sessionQueue, setSessionQueue] = useState<Word[]>([]);
  // Ticks every minute so time-based queues (e.g. "forgotten, retry in 1h") refresh without a reload
  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setClockTick(x => x + 1), 60000);
    return () => clearInterval(t);
  }, []);

  // Daily activity logs for streak & statistics (stored locally)
  const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const [activityLog, setActivityLog] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('francab_activity') || '{}'); } catch { return {}; }
  });
  const [exerciseLog, setExerciseLog] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('francab_activity_ex') || '{}'); } catch { return {}; }
  });
  const recordActivity = () => {
    const key = dayKey(new Date());
    setActivityLog(prev => {
      const next = { ...prev, [key]: (prev[key] || 0) + 1 };
      localStorage.setItem('francab_activity', JSON.stringify(next));
      return next;
    });
  };
  const recordExerciseActivity = (count = 1) => {
    const key = dayKey(new Date());
    setExerciseLog(prev => {
      const next = { ...prev, [key]: (prev[key] || 0) + count };
      localStorage.setItem('francab_activity_ex', JSON.stringify(next));
      return next;
    });
  };
  const streak = useMemo(() => {
    const active = (key: string) => (activityLog[key] || 0) > 0 || (exerciseLog[key] || 0) > 0;
    let s = 0;
    const d = new Date();
    if (!active(dayKey(d))) d.setDate(d.getDate() - 1); // streak survives if today not started yet
    while (active(dayKey(d))) { s++; d.setDate(d.getDate() - 1); }
    return s;
  }, [activityLog, exerciseLog]);
  const [isStatsModalOpen, setIsStatsModalOpen] = useState(false);
  const [forecastRange, setForecastRange] = useState<30 | 90 | 180 | 365>(30);
  const [currentReviewIndex, setCurrentReviewIndex] = useState(0);
  const [showTranslation, setShowTranslation] = useState(false);
  // Commit-before-reveal: the learner declares "I know / I don't know" BEFORE seeing the answer,
  // then verifies against it. Grading after the reveal alone invites the illusion of knowing.
  const [cardCommit, setCardCommit] = useState<'known' | 'unknown' | null>(null);
  const [justMastered, setJustMastered] = useState<string | null>(null);
  
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [isInstallModalOpen, setIsInstallModalOpen] = useState(false);
  const [isWordListModalOpen, setIsWordListModalOpen] = useState(false);
  const [isTextExerciseModalOpen, setIsTextExerciseModalOpen] = useState(false);
  const [isMatchModalOpen, setIsMatchModalOpen] = useState(false);
  // Exercise words organized into 3 tiers (forgotten / almost / remembered), shared by all activities
  const [exerciseBuckets, setExerciseBuckets] = useState<ExBuckets>(EMPTY_BUCKETS);
  const [currentExerciseBatch, setCurrentExerciseBatch] = useState<Word[]>([]); // text-exercise's in-flight 5-word batch
  const exerciseQueueRestored = React.useRef(false);

  // Restore bucket positions from the previous session (stored as word ids per tier)
  useEffect(() => {
    if (!hasLoaded || exerciseQueueRestored.current) return;
    exerciseQueueRestored.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem('francab_exercise_buckets') || 'null');
      if (saved && saved.lang === targetLanguage && saved.buckets) {
        const byId = new Map(words.map(w => [w.id, w]));
        const restoreTier = (ids: any): Word[] =>
          Array.isArray(ids) ? (ids.map((id: string) => byId.get(id)).filter(Boolean) as Word[]) : [];
        const restored: ExBuckets = {
          forgotten: restoreTier(saved.buckets.forgotten),
          almost: restoreTier(saved.buckets.almost),
          remembered: restoreTier(saved.buckets.remembered),
        };
        if (restored.forgotten.length + restored.almost.length + restored.remembered.length > 0) {
          setExerciseBuckets(restored);
        }
      }
    } catch { /* corrupt data — start fresh */ }
  }, [hasLoaded, words, targetLanguage]);

  // Persist bucket positions on every change (unfinished text-exercise batch words go to the front of their tier)
  useEffect(() => {
    if (!hasLoaded || !exerciseQueueRestored.current) return;
    const withBatch: ExBuckets = { forgotten: [...exerciseBuckets.forgotten], almost: [...exerciseBuckets.almost], remembered: [...exerciseBuckets.remembered] };
    [...currentExerciseBatch].reverse().forEach(w => {
      const tier = currentExerciseBatchTiers.current[w.id] || 'almost';
      withBatch[tier] = [w, ...withBatch[tier]];
    });
    localStorage.setItem('francab_exercise_buckets', JSON.stringify({
      lang: targetLanguage,
      buckets: {
        forgotten: withBatch.forgotten.map(w => w.id),
        almost: withBatch.almost.map(w => w.id),
        remembered: withBatch.remembered.map(w => w.id),
      },
    }));
  }, [exerciseBuckets, currentExerciseBatch, targetLanguage, hasLoaded]);
  const [wordListSearchQuery, setWordListSearchQuery] = useState('');
  const [isStoryLoading, setIsStoryLoading] = useState(false);
  const [generatedStory, setGeneratedStory] = useState<{
    title: string;
    story: string;
    gaps: string[];
    shuffledGaps: string[];
  } | null>(null);
  const [userAnswers, setUserAnswers] = useState<string[]>([]);
  const [exerciseFeedback, setExerciseFeedback] = useState<'success' | 'error' | null>(null);
  const [selectedGapIndex, setSelectedGapIndex] = useState<number | null>(null);
  const [wordHintIndex, setWordHintIndex] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingWord, setEditingWord] = useState<Word | null>(null);

  // Match Game State
  const [matchPool, setMatchPool] = useState<Word[]>([]);
  const [matchedIds, setMatchedIds] = useState<Set<string>>(new Set());
  const [currentMatchWords, setCurrentMatchWords] = useState<Word[]>([]);
  const [shuffledTranslations, setShuffledTranslations] = useState<{id: string, text: string}[]>([]);
  const [selectedWordId, setSelectedWordId] = useState<string | null>(null);
  const [selectedTranslationId, setSelectedTranslationId] = useState<string | null>(null);
  const [successfullyMatched, setSuccessfullyMatched] = useState<string | null>(null);
  const [wrongMatch, setWrongMatch] = useState<{wordId: string, transId: string} | null>(null);
  const [isProcessingMatch, setIsProcessingMatch] = useState(false);

  // Reverse practice (translation → French) state
  const [isReverseModalOpen, setIsReverseModalOpen] = useState(false);
  const [reverseWord, setReverseWord] = useState<Word | null>(null);
  const [reverseTier, setReverseTier] = useState<ExTier | null>(null);
  const [reverseRevealed, setReverseRevealed] = useState(false);
  const [reverseSession, setReverseSession] = useState({ done: 0, correct: 0 });
  const [reverseSessionOver, setReverseSessionOver] = useState(false);
  const [reverseLimit, setReverseLimit] = useState(EXERCISE_SESSION_SIZE);

  // Quiz (word + 4 choices) state
  const [isQuizModalOpen, setIsQuizModalOpen] = useState(false);
  const [quizWord, setQuizWord] = useState<Word | null>(null);
  const [quizTier, setQuizTier] = useState<ExTier | null>(null);
  const [quizOptions, setQuizOptions] = useState<string[]>([]);
  const [quizSelected, setQuizSelected] = useState<string | null>(null);
  const [quizSession, setQuizSession] = useState({ done: 0, correct: 0 });
  const [quizSessionOver, setQuizSessionOver] = useState(false);

  // Typing activity: translation shown, type the French word
  const [isTypingModalOpen, setIsTypingModalOpen] = useState(false);
  const [typingWord, setTypingWord] = useState<Word | null>(null);
  const [typingTier, setTypingTier] = useState<ExTier | null>(null);
  const [typingInput, setTypingInput] = useState('');
  const [typingResult, setTypingResult] = useState<'correct' | 'wrong' | null>(null);
  const [typingSession, setTypingSession] = useState({ done: 0, correct: 0 });
  const [typingSessionOver, setTypingSessionOver] = useState(false);
  const [typingLimit, setTypingLimit] = useState(EXERCISE_SESSION_SIZE);

  // Compose activity: write your own sentence with the word, AI checks it
  const [isComposeModalOpen, setIsComposeModalOpen] = useState(false);
  const [composeWord, setComposeWord] = useState<Word | null>(null);
  const [composeTier, setComposeTier] = useState<ExTier | null>(null);
  const [composeInput, setComposeInput] = useState('');
  const [composeChecking, setComposeChecking] = useState(false);
  const [composeFeedback, setComposeFeedback] = useState<{ wordOk: boolean; corrected: string; feedback: string } | null>(null);
  const [composeSession, setComposeSession] = useState({ done: 0, correct: 0 });
  const [composeSessionOver, setComposeSessionOver] = useState(false);
  const [composeLimit, setComposeLimit] = useState(COMPOSE_SESSION_SIZE);

  // Combo session: chains all 6 activities —
  // Rappel actif (10) → Relier les mots (15) → Quiz (15) → Écrivez le mot (5) → Phrases (5) → Composez (5) = 55 words
  type ComboPhase = 'reverse' | 'match' | 'quiz' | 'typing' | 'text' | 'compose';
  const [comboMode, setComboMode] = useState<ComboPhase | null>(null);
  const [comboResults, setComboResults] = useState<Record<ComboPhase, { correct: number; total: number }>>({
    reverse: { correct: 0, total: 0 },
    match: { correct: 0, total: 0 },
    quiz: { correct: 0, total: 0 },
    typing: { correct: 0, total: 0 },
    text: { correct: 0, total: 0 },
    compose: { correct: 0, total: 0 },
  });
  const [isComboSummaryOpen, setIsComboSummaryOpen] = useState(false);

  // Exercise words are eligible once reviewed at least once in flashcards, for the current language
  const buildExerciseEligible = useCallback(() => {
    return words.filter(w => {
      const matchesLang = targetLanguage === 'Russe'
        ? (!w.target_lang || w.target_lang === 'Russe')
        : (w.target_lang === targetLanguage);
      return matchesLang && w.word && w.translation && !!w.last_reviewed_at;
    });
  }, [words, targetLanguage]);

  // Split eligible words into 3 tiers by their last flashcard grade.
  // Within a tier: today's words first, then weaker (lower review_count) words first.
  // Ungraded words (reviewed but never explicitly graded — legacy data) default into "almost".
  const partitionIntoBuckets = (eligible: Word[]): ExBuckets => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayTs = startOfToday.getTime();
    const byRecency = (a: Word, b: Word) => {
      const ta = a.last_reviewed_at && a.last_reviewed_at >= todayTs ? 0 : 1;
      const tb = b.last_reviewed_at && b.last_reviewed_at >= todayTs ? 0 : 1;
      if (ta !== tb) return ta - tb;
      return (a.review_count ?? 0) - (b.review_count ?? 0);
    };
    return {
      forgotten: eligible.filter(w => w.last_grade === 'forgotten').sort(byRecency),
      almost: eligible.filter(w => w.last_grade !== 'forgotten' && w.last_grade !== 'remembered').sort(byRecency),
      remembered: eligible.filter(w => w.last_grade === 'remembered').sort(byRecency),
    };
  };

  // Merge newly-eligible words (reviewed since the buckets were last built) into their tier's end.
  // Buckets are otherwise left untouched — in-session promotions must persist across activities.
  const getOrBuildBuckets = (): ExBuckets => {
    const eligible = buildExerciseEligible();
    const total = exerciseBuckets.forgotten.length + exerciseBuckets.almost.length + exerciseBuckets.remembered.length;
    let buckets: ExBuckets;
    if (total === 0) {
      buckets = partitionIntoBuckets(eligible);
    } else {
      const known = new Set([
        ...exerciseBuckets.forgotten.map(w => w.id),
        ...exerciseBuckets.almost.map(w => w.id),
        ...exerciseBuckets.remembered.map(w => w.id),
      ]);
      const fresh = eligible.filter(w => !known.has(w.id));
      if (fresh.length === 0) {
        buckets = exerciseBuckets;
      } else {
        const seeded = partitionIntoBuckets(fresh);
        buckets = {
          forgotten: [...exerciseBuckets.forgotten, ...seeded.forgotten],
          almost: [...exerciseBuckets.almost, ...seeded.almost],
          remembered: [...exerciseBuckets.remembered, ...seeded.remembered],
        };
      }
    }
    setExerciseBuckets(buckets);
    return buckets;
  };

  // Tier orders by activity difficulty:
  // easy activities (reverse, match, quiz) drill weak words first;
  // hard/production activities (typing, phrases, compose) challenge well-known words first.
  const EASY_ORDER: ExTier[] = ['forgotten', 'almost', 'remembered'];
  const HARD_ORDER: ExTier[] = ['remembered', 'almost', 'forgotten'];

  // Pure pull following the given tier order, skipping excluded (already seen this session) words.
  // If buckets run out mid-pull, rebuilds a fresh cycle from all eligible words.
  const pullFromBuckets = (
    buckets: ExBuckets,
    n: number,
    opts?: { order?: ExTier[]; exclude?: Set<string> }
  ): { picked: Array<{ word: Word; tier: ExTier }>; rest: ExBuckets } => {
    const order = opts?.order ?? EASY_ORDER;
    const exclude = opts?.exclude;
    const rest: ExBuckets = { forgotten: [...buckets.forgotten], almost: [...buckets.almost], remembered: [...buckets.remembered] };
    const picked: Array<{ word: Word; tier: ExTier }> = [];
    const takePass = () => {
      for (const key of order) {
        while (picked.length < n) {
          const idx = exclude ? rest[key].findIndex(w => !exclude.has(w.id)) : (rest[key].length > 0 ? 0 : -1);
          if (idx === -1) break;
          picked.push({ word: rest[key][idx], tier: key });
          rest[key].splice(idx, 1);
        }
        if (picked.length >= n) break;
      }
    };
    takePass();
    if (picked.length < n) {
      const remaining = rest.forgotten.length + rest.almost.length + rest.remembered.length;
      if (remaining === 0) {
        // Whole cycle exhausted: reseed from all eligible words (except ones already in hand)
        const eligible = buildExerciseEligible();
        const pickedIds = new Set(picked.map(p => p.word.id));
        const fresh = eligible.filter(w => !pickedIds.has(w.id) && !exclude?.has(w.id));
        if (fresh.length > 0) {
          const seeded = partitionIntoBuckets(fresh);
          rest.forgotten = seeded.forgotten;
          rest.almost = seeded.almost;
          rest.remembered = seeded.remembered;
          takePass();
        }
      }
    }
    return { picked, rest };
  };

  const pullWords = (n: number, order?: ExTier[]): Array<{ word: Word; tier: ExTier }> => {
    const buckets = getOrBuildBuckets();
    const { picked, rest } = pullFromBuckets(buckets, n, { order, exclude: sessionSeenIds.current });
    picked.forEach(p => sessionSeenIds.current.add(p.word.id));
    setExerciseBuckets(rest);
    return picked;
  };

  // Resolve one word's answer in any activity:
  // - correct → promotes one tier (forgotten→almost→remembered); remembered+correct is done for this cycle,
  //   so a word answered right simply stops coming back
  // - wrong → forgotten/almost repeat within their own tier (the reinforcement loop:
  //   keep failing it and it keeps coming back); remembered demotes to almost
  //
  // Scheduling: activities are the ONLY objective signal, so this is where the card ladder is corrected.
  // A wrong answer brakes the word (review tomorrow, one level down, mastered → learning) — without this
  // nothing could stop a poorly-known word from marching to mastered on the fixed ladder.
  // A correct answer advances the ladder only in production activities (`objective: true` — typing the
  // word, composing a sentence); recognition (quiz, matching) stays label-only, since a 1-in-4 guess
  // must not earn progress.
  const resolveExerciseAnswer = (word: Word, tier: ExTier, wasCorrect: boolean, objective = false) => {
    setExerciseBuckets(prev => {
      if (wasCorrect) {
        if (tier === 'forgotten') return { ...prev, almost: [...prev.almost, word] };
        if (tier === 'almost') return { ...prev, remembered: [...prev.remembered, word] };
        return prev; // remembered + correct: fully cleared this cycle
      }
      if (tier === 'remembered') return { ...prev, almost: [...prev.almost, word] };
      return { ...prev, [tier]: [...prev[tier], word] };
    });

    // Objectively verified success = real retrieval → advance the ladder like a flashcard "Retenu"
    if (wasCorrect && objective) {
      setWords(prev => prev.map(w => (w.id === word.id ? applyGrade(w, 'remembered') : w)));
      return;
    }

    const newGrade: ReviewGrade | null = wasCorrect
      ? (tier === 'forgotten' ? 'almost' : tier === 'almost' ? 'remembered' : null)
      : (tier === 'remembered' ? 'almost' : tier);
    if (!newGrade) return;

    setWords(prev => prev.map(w => {
      if (w.id !== word.id) return w;
      if (wasCorrect) {
        return { ...w, last_grade: newGrade }; // label only — recognition doesn't accelerate scheduling
      }
      const DAY = 1000 * 60 * 60 * 24;
      return {
        ...w,
        next_review_at: Math.min(w.next_review_at, Date.now() + DAY),
        review_count: Math.max(0, (w.review_count ?? 0) - 1),
        status: w.status === 'mastered' ? 'learning' as const : w.status,
        last_grade: newGrade,
      };
    }));
  };

  const startMatchGame = useCallback(() => {
    const buckets = getOrBuildBuckets();
    const total = buckets.forgotten.length + buckets.almost.length + buckets.remembered.length;
    if (total < 5) {
      alert("Il faut au moins 5 mots révisés en mode cartes pour jouer. Révisez d'abord quelques mots !");
      return;
    }
    const { picked, rest } = pullFromBuckets(buckets, EXERCISE_SESSION_SIZE);
    setExerciseBuckets(rest);

    const pool = picked.map(p => p.word);
    matchPoolTiers.current = Object.fromEntries(picked.map(p => [p.word.id, p.tier]));

    matchWrongWordIds.current = new Set();

    setMatchPool(pool);
    setMatchedIds(new Set());

    const initialWords = pool.slice(0, 5);
    setCurrentMatchWords([...initialWords].sort(() => Math.random() - 0.5));

    const initialTranslations = initialWords.map(w => ({ id: w.id, text: w.translation })).sort(() => Math.random() - 0.5);
    setShuffledTranslations(initialTranslations);

    setSelectedWordId(null);
    setSelectedTranslationId(null);
    setSuccessfullyMatched(null);
    setWrongMatch(null);
    setIsMatchModalOpen(true);
  }, [exerciseBuckets, words, targetLanguage]);

  const openTextExercise = () => {
    getOrBuildBuckets();
    setIsTextExerciseModalOpen(true);
  };

  // ===== Reverse practice: translation shown, recall the French word =====
  // Sessions are capped at EXERCISE_SESSION_SIZE words; each new session pulls
  // the NEXT words from the shared buckets (already-seen words never repeat within a cycle).

  const startReversePractice = (limit?: unknown) => {
    const sessionSize = typeof limit === 'number' ? limit : EXERCISE_SESSION_SIZE;
    sessionSeenIds.current = new Set();
    const [pulled] = pullWords(1);
    if (!pulled) { alert("Révisez d'abord quelques mots en mode cartes !"); return; }
    setReverseLimit(sessionSize);
    setReverseWord(pulled.word);
    setReverseTier(pulled.tier);
    setReverseRevealed(false);
    setReverseSession({ done: 0, correct: 0 });
    setReverseSessionOver(false);
    setIsReverseModalOpen(true);
  };

  const nextReverseWord = (wasCorrect: boolean) => {
    const next = { done: reverseSession.done + 1, correct: reverseSession.correct + (wasCorrect ? 1 : 0) };
    setReverseSession(next);
    if (next.done >= reverseLimit) {
      setReverseSessionOver(true);
      setReverseWord(null);
      setReverseTier(null);
      return;
    }
    const [pulled] = pullWords(1);
    if (!pulled) { setReverseSessionOver(true); setReverseWord(null); setReverseTier(null); return; }
    setReverseWord(pulled.word);
    setReverseTier(pulled.tier);
    setReverseRevealed(false);
  };

  // ===== Quiz: French word + 4 translation options of the same part of speech =====

  // Part-of-speech heuristic from stored data: verbs carry an infinitive, nouns a gender
  const posOf = (w: Word): 'verb' | 'noun' | 'other' =>
    (w.infinitive && w.infinitive.trim()) ? 'verb'
      : (w.gender === 'm' || w.gender === 'f') ? 'noun'
      : 'other';

  const buildQuizOptions = (target: Word): string[] => {
    const ml = (w: Word) => targetLanguage === 'Russe'
      ? (!w.target_lang || w.target_lang === 'Russe')
      : w.target_lang === targetLanguage;
    const pool = words.filter(w =>
      w.id !== target.id && ml(w) && w.translation &&
      normalizeWord(w.translation) !== normalizeWord(target.translation)
    );
    // Same part of speech first, so options are not trivially distinguishable
    const samePos = pool.filter(w => posOf(w) === posOf(target)).sort(() => Math.random() - 0.5);
    const others = pool.filter(w => posOf(w) !== posOf(target)).sort(() => Math.random() - 0.5);

    const distractors: string[] = [];
    const seen = new Set([normalizeWord(target.translation)]);
    for (const src of [...samePos, ...others]) {
      const key = normalizeWord(src.translation);
      if (seen.has(key)) continue;
      seen.add(key);
      distractors.push(src.translation);
      if (distractors.length === 3) break;
    }
    if (distractors.length < 3) return [];
    return [target.translation, ...distractors].sort(() => Math.random() - 0.5);
  };

  // AI invents 3 plausible wrong translations of the SAME part of speech and form
  const generateQuizDistractors = async (target: Word): Promise<string[] | null> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || (window as any).GEMINI_API_KEY;
      if (!apiKey) return null;
      const ai = new GoogleGenAI({ apiKey });
      const response = await generateWithFallback(ai, {
        contents: `Tu prépares un quiz de vocabulaire français.
Mot français : "${target.word}"
Traduction correcte en ${currentLangObj.aiName} : "${target.translation}"

Invente 3 traductions FAUSSES mais plausibles en ${currentLangObj.aiName} :
- STRICTEMENT la même partie du discours et la même forme grammaticale que la traduction correcte (verbe conjugué → verbes conjugués à la même personne et au même temps ; nom → noms ; adjectif → adjectifs ; expression/phrase → expressions similaires)
- sens clairement différent de la traduction correcte (pas de synonymes !)
- longueur et registre similaires, pour que la bonne réponse ne soit pas évidente

Réponds UNIQUEMENT avec un JSON brut, sans markdown : {"options":["...","...","..."]}`,
        config: {}
      });
      const result = JSON.parse(extractJson(response) || '{}');
      if (Array.isArray(result.options)) {
        const seen = new Set([normalizeWord(target.translation)]);
        const opts = result.options
          .filter((o: any) => typeof o === 'string' && o.trim())
          .filter((o: string) => {
            const k = normalizeWord(o);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .slice(0, 3);
        if (opts.length === 3) return opts;
      }
      return null;
    } catch {
      return null;
    }
  };

  const prepareQuizQuestion = async (w: Word, tier: ExTier) => {
    setQuizWord(w);
    setQuizTier(tier);
    setQuizOptions([]); // empty = loading state
    setQuizSelected(null);
    const aiOpts = await generateQuizDistractors(w);
    const opts = aiOpts
      ? [w.translation, ...aiOpts].sort(() => Math.random() - 0.5)
      : buildQuizOptions(w); // offline/quota fallback from the base
    if (opts.length < 4) {
      setExerciseBuckets(prev => ({ ...prev, [tier]: [w, ...prev[tier]] }));
      alert("Impossible de préparer la question. Réessayez.");
      setIsQuizModalOpen(false);
      setQuizWord(null);
      setQuizTier(null);
      return;
    }
    setQuizOptions(opts);
  };

  const startQuizGame = () => {
    sessionSeenIds.current = new Set();
    const [pulled] = pullWords(1);
    if (!pulled) { alert("Révisez d'abord quelques mots en mode cartes !"); return; }
    setQuizSession({ done: 0, correct: 0 });
    setQuizSessionOver(false);
    setIsQuizModalOpen(true);
    prepareQuizQuestion(pulled.word, pulled.tier);
  };

  // Called after the user answers the current question, with whether it was correct
  const advanceQuiz = (wasCorrect: boolean) => {
    const next = { done: quizSession.done + 1, correct: quizSession.correct + (wasCorrect ? 1 : 0) };
    setQuizSession(next);
    if (next.done >= EXERCISE_SESSION_SIZE) {
      setQuizSessionOver(true);
      setQuizWord(null);
      setQuizTier(null);
      return;
    }
    const [pulled] = pullWords(1);
    if (!pulled) { setQuizSessionOver(true); setQuizWord(null); setQuizTier(null); return; }
    prepareQuizQuestion(pulled.word, pulled.tier);
  };

  // ===== Typing activity: translation shown, type the French word (production practice) =====

  const startTypingActivity = (limit?: unknown) => {
    const sessionSize = typeof limit === 'number' ? limit : EXERCISE_SESSION_SIZE;
    sessionSeenIds.current = new Set();
    const [pulled] = pullWords(1, HARD_ORDER);
    if (!pulled) { alert("Révisez d'abord quelques mots en mode cartes !"); return; }
    setTypingLimit(sessionSize);
    setTypingWord(pulled.word);
    setTypingTier(pulled.tier);
    setTypingInput('');
    setTypingResult(null);
    setTypingSession({ done: 0, correct: 0 });
    setTypingSessionOver(false);
    setIsTypingModalOpen(true);
  };

  const checkTypingAnswer = () => {
    if (!typingWord || typingResult !== null || !typingInput.trim()) return;
    const norm = (s: string) => normalizeWord(stripArticles(s));
    const ok = norm(typingInput) === norm(typingWord.word);
    setTypingResult(ok ? 'correct' : 'wrong');
    if (typingTier) resolveExerciseAnswer(typingWord, typingTier, ok, true); // typed = objectively verified
    recordExerciseActivity();
    speak(typingWord.word);
    if (ok) setTimeout(() => nextTypingWord(true), 1200);
  };

  const nextTypingWord = (wasCorrect: boolean) => {
    const next = { done: typingSession.done + 1, correct: typingSession.correct + (wasCorrect ? 1 : 0) };
    setTypingSession(next);
    if (next.done >= typingLimit) {
      setTypingSessionOver(true);
      setTypingWord(null);
      setTypingTier(null);
      return;
    }
    const [pulled] = pullWords(1, HARD_ORDER);
    if (!pulled) { setTypingSessionOver(true); setTypingWord(null); setTypingTier(null); return; }
    setTypingWord(pulled.word);
    setTypingTier(pulled.tier);
    setTypingInput('');
    setTypingResult(null);
  };

  // ===== Compose activity: write your own sentence with the word, AI verifies usage =====

  const startComposeActivity = (limit?: unknown) => {
    const sessionSize = typeof limit === 'number' ? limit : COMPOSE_SESSION_SIZE;
    sessionSeenIds.current = new Set();
    const [pulled] = pullWords(1, HARD_ORDER);
    if (!pulled) { alert("Révisez d'abord quelques mots en mode cartes !"); return; }
    setComposeLimit(sessionSize);
    setComposeWord(pulled.word);
    setComposeTier(pulled.tier);
    setComposeInput('');
    setComposeFeedback(null);
    setComposeSession({ done: 0, correct: 0 });
    setComposeSessionOver(false);
    setIsComposeModalOpen(true);
  };

  // Skip the current word: it goes back to the END of its tier, so it returns in a later cycle,
  // and it stays out of THIS session (sessionSeenIds already holds it). Skips don't count as answers.
  const skipComposeWord = () => {
    if (!composeWord || !composeTier || composeChecking || composeFeedback) return;
    const skipped = composeWord;
    const tier = composeTier;
    setExerciseBuckets(prev => ({ ...prev, [tier]: [...prev[tier], skipped] }));

    const [pulled] = pullWords(1, HARD_ORDER);
    if (!pulled) { setComposeSessionOver(true); setComposeWord(null); setComposeTier(null); return; }
    setComposeWord(pulled.word);
    setComposeTier(pulled.tier);
    setComposeInput('');
    setComposeFeedback(null);
  };

  const checkComposeSentence = async () => {
    if (!composeWord || composeChecking || composeFeedback || composeInput.trim().length < 3) return;
    setComposeChecking(true);
    try {
      const apiKey = process.env.GEMINI_API_KEY || (window as any).GEMINI_API_KEY;
      if (!apiKey) throw new Error("Clé API introuvable");
      const ai = new GoogleGenAI({ apiKey });
      const response = await generateWithFallback(ai, {
        contents: `Tu es un professeur de français bienveillant. L'apprenant étudie le mot "${composeWord.word}" (traduction : "${composeWord.translation}").
Il a écrit cette phrase pour s'entraîner : "${composeInput.trim()}"

Évalue :
1. "wordOk" : le mot "${composeWord.word}" (ou sa forme conjuguée/accordée) est-il présent ET utilisé avec le bon sens dans la phrase ?
2. "corrected" : la phrase corrigée (orthographe, grammaire, naturel). Si la phrase est déjà parfaite, recopie-la telle quelle.
3. "feedback" : 1-2 phrases d'explication en ${currentLangObj.aiName} — ce qui est bien et ce qu'il faut corriger.

Réponds UNIQUEMENT avec un JSON brut, sans markdown :
{"wordOk": true, "corrected": "...", "feedback": "..."}`,
        config: {}
      });
      const result = JSON.parse(extractJson(response) || '{}');
      if (typeof result.wordOk !== 'boolean') throw new Error('bad response');
      setComposeFeedback({
        wordOk: result.wordOk,
        corrected: result.corrected || composeInput.trim(),
        feedback: result.feedback || '',
      });
      if (composeTier) resolveExerciseAnswer(composeWord, composeTier, result.wordOk, true); // AI-verified production
      recordExerciseActivity();
    } catch (e) {
      console.error('Compose check error:', e);
      alert("Erreur de vérification. Réessayez.");
    } finally {
      setComposeChecking(false);
    }
  };

  const nextComposeWord = () => {
    const wasCorrect = !!composeFeedback?.wordOk;
    const next = { done: composeSession.done + 1, correct: composeSession.correct + (wasCorrect ? 1 : 0) };
    setComposeSession(next);
    if (next.done >= composeLimit) {
      setComposeSessionOver(true);
      setComposeWord(null);
      setComposeTier(null);
      return;
    }
    const [pulled] = pullWords(1, HARD_ORDER);
    if (!pulled) { setComposeSessionOver(true); setComposeWord(null); setComposeTier(null); return; }
    setComposeWord(pulled.word);
    setComposeTier(pulled.tier);
    setComposeInput('');
    setComposeFeedback(null);
  };

  // ===== Combo session: runs all 4 activities back-to-back on the same 50-word batch =====

  const startComboSession = () => {
    const buckets = getOrBuildBuckets();
    const total = buckets.forgotten.length + buckets.almost.length + buckets.remembered.length;
    if (total < 5) {
      alert("Révisez d'abord quelques mots en mode cartes !");
      return;
    }
    setComboResults({
      reverse: { correct: 0, total: 0 },
      match: { correct: 0, total: 0 },
      quiz: { correct: 0, total: 0 },
      typing: { correct: 0, total: 0 },
      text: { correct: 0, total: 0 },
      compose: { correct: 0, total: 0 },
    });
    setComboMode('reverse');
    startReversePractice(10);
  };

  // Called when the user bails out of the combo sequence via any modal's close button
  const cancelCombo = () => setComboMode(null);


  useEffect(() => {
    if (selectedWordId && selectedTranslationId && !isProcessingMatch) {
      if (selectedWordId === selectedTranslationId) {
        // MATCH!
        setIsProcessingMatch(true);
        const matchedId = selectedWordId;
        setSuccessfullyMatched(matchedId);

        setTimeout(() => {
          recordExerciseActivity();
          // Resolve this word now: correct if it was never mismatched during this game
          const wordObj = matchPool.find(w => w.id === matchedId);
          const tier = matchPoolTiers.current[matchedId];
          if (wordObj && tier) {
            resolveExerciseAnswer(wordObj, tier, !matchWrongWordIds.current.has(matchedId));
          }

          setMatchedIds(prev => {
            const next = new Set(prev);
            next.add(matchedId);
            return next;
          });
          
          // Update words and shuffle
          setCurrentMatchWords(prev => {
            const nextWords = prev.filter(w => w.id !== matchedId);
            
            const remainingPool = matchPool.filter(w => {
              const inMatched = matchedIds.has(w.id) || w.id === matchedId;
              const inCurrent = prev.some(p => p.id === w.id);
              return !inMatched && !inCurrent;
            });

            if (remainingPool.length > 0) {
              nextWords.push(remainingPool[0]);
            }
            
            // SHUFFLE the whole set to create the "reshuffle" effect
            return [...nextWords].sort(() => Math.random() - 0.5);
          });

          setShuffledTranslations(prev => {
            const nextTrans = prev.filter(t => t.id !== matchedId);
            
            // We need to find which word was just added to currentMatchWords to add its translation here
            // But since we are shuffling, we can just sync it with the NEW pool of words
            // To be safe and simple, let's just find the IDs that ARE in currentMatchWords (after match)
            // and add the one that's missing from translations
            
            const currentIds = currentMatchWords.filter(w => w.id !== matchedId).map(w => w.id);
            const remainingPool = matchPool.filter(w => {
              const inMatched = matchedIds.has(w.id) || w.id === matchedId;
              const inCurrent = currentIds.includes(w.id);
              return !inMatched && !inCurrent;
            });

            if (remainingPool.length > 0) {
              const newWord = remainingPool[0];
              nextTrans.push({ id: newWord.id, text: newWord.translation });
            }
            
            // SHUFFLE translations too
            return [...nextTrans].sort(() => Math.random() - 0.5);
          });

          setSelectedWordId(null);
          setSelectedTranslationId(null);
          setSuccessfullyMatched(null);
          setIsProcessingMatch(false);
        }, 1500); 
      } else {
        // WRONG — remember this word had a mismatch; it affects grading once it's finally matched
        matchWrongWordIds.current.add(selectedWordId);
        setIsProcessingMatch(true);
        setWrongMatch({ wordId: selectedWordId, transId: selectedTranslationId });
        setTimeout(() => {
          setWrongMatch(null);
          setSelectedWordId(null);
          setSelectedTranslationId(null);
          setIsProcessingMatch(false);
        }, 800);
      }
    }
  }, [selectedWordId, selectedTranslationId, matchPool, matchedIds, isProcessingMatch, currentMatchWords]);

  const wordToDelete = useMemo(() => words.find(w => w.id === deletingId), [words, deletingId]);

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingWord) return;
    setWords(prev => prev.map(w => w.id === editingWord.id ? editingWord : w));
    setEditingWord(null);
  };

  // Handle PWA Install Prompt
  useEffect(() => {
    const handler = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleDeleteWord = (id: string, e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setDeletingId(id);
  };

  const handleHardReset = async () => {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        await registration.unregister();
      }
    }
    
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      for (const name of cacheNames) {
        await caches.delete(name);
      }
    }
    
    window.location.reload();
  };

  const handleInstallClick = async () => {
    console.log('Install button clicked. Prompt available:', !!deferredPrompt);
    if (deferredPrompt) {
      try {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        console.log('User response to install prompt:', outcome);
        if (outcome === 'accepted') {
          setDeferredPrompt(null);
        }
      } catch (err) {
        console.error('Installation error:', err);
        setIsInstallModalOpen(true);
      }
    } else {
      console.log('No prompt available, opening manual guide');
      setIsInstallModalOpen(true);
    }
  };

  // Handle Auth State
  useEffect(() => {
    if (!auth) {
      setIsAuthLoading(false);
      return;
    }
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthLoading(false);
      setHasLoaded(false);
    });
    return () => unsubscribe();
  }, []);

  // Load words (Firestore or LocalStorage)
  useEffect(() => {
    if (isAuthLoading) return;

    if (user && db) {
      // Sync with Firestore
      setIsSyncing(true);
      const userDocRef = doc(db, 'users', user.uid);
      
      // Initial load
      getDoc(userDocRef).then((docSnap) => {
        if (docSnap.exists()) {
          setWords(docSnap.data().words || []);
          setSyncError(null);
        }
        setHasLoaded(true);
        setIsSyncing(false);
      }).catch(err => {
        console.error("Initial load error:", err);
        if (err.message?.includes('permission-denied')) {
          setSyncError("Доступ к базе данных заблокирован правилами Firebase. Пожалуйста, обновите вкладку 'Rules' в консоли.");
        } else {
          setSyncError(`Ошибка загрузки: ${err.message}`);
        }
        setHasLoaded(true);
        setIsSyncing(false);
      });

      // Listen for remote changes
      const unsubscribe = onSnapshot(userDocRef, (docSnap) => {
        if (docSnap.exists()) {
          const remoteWords = docSnap.data().words || [];
          setWords(prev => {
            if (JSON.stringify(prev) !== JSON.stringify(remoteWords)) {
              return remoteWords;
            }
            return prev;
          });
          setSyncError(null);
        }
      }, (err) => {
        console.error("Snapshot error:", err);
        if (err.message?.includes('permission-denied')) {
          setSyncError("Доступ заблокирован (Permission Denied). Проверьте правила Firestore.");
        }
      });
      return () => unsubscribe();
    } else {
      // Fallback to LocalStorage
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        try {
          setWords(JSON.parse(saved));
        } catch (e) {
          console.error("Failed to parse words", e);
        }
      }
      setHasLoaded(true);
    }
  }, [user, isAuthLoading]);

  // Save words (Firestore or LocalStorage)
  useEffect(() => {
    if (isAuthLoading || !hasLoaded) return;

    const sanitizeForFirestore = (data: any): any => {
      if (Array.isArray(data)) {
        return data.map(sanitizeForFirestore);
      } else if (data !== null && typeof data === 'object') {
        const sanitized: any = {};
        for (const [key, value] of Object.entries(data)) {
          if (value !== undefined) {
            sanitized[key] = sanitizeForFirestore(value);
          }
        }
        return sanitized;
      }
      return data;
    };

    if (user && db) {
      // Debounce: batch rapid changes (e.g. grading cards) into one write
      const timer = setTimeout(async () => {
        try {
          const userDocRef = doc(db, 'users', user.uid);
          const sanitizedWords = sanitizeForFirestore(words);
          await setDoc(userDocRef, { words: sanitizedWords }, { merge: true });
        } catch (e) {
          console.error("Error saving to Firestore:", e);
        }
      }, 1500);
      return () => clearTimeout(timer);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(words));
    }
  }, [words, user, isAuthLoading]);

  const handleLogin = async () => {
    if (!auth) {
      setError("Firebase n'est pas configuré. Veuillez vérifier vos clés API.");
      return;
    }
    setIsLoggingIn(true);
    setError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error: any) {
      console.error("Login failed:", error);
      if (error.code === 'auth/popup-blocked') {
        setError("Le pop-up de connexion a été bloqué par votre navigateur. Veuillez autoriser les pop-ups.");
      } else if (error.code === 'auth/unauthorized-domain') {
        setError("Ce domaine n'est pas autorisé dans Firebase. Ajoutez-le dans 'Authorized domains'.");
      } else {
        setError(`Échec de la connexion: ${error.message || "Veuillez réessayer."}`);
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    if (!auth) return;
    try {
      await signOut(auth);
      setWords([]); // Clear words on logout
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  // Daily review queue with a single shared limit:
  // - max DAILY_REVIEW_LIMIT cards per day (retries + scheduled reviews + new words all share it)
  // - of which max DAILY_NEW_LIMIT brand-new words
  // - ORDER: most-overdue first. A word due 5 days ago is on the edge of being lost and
  //   must come before everything else; new words enter ONLY when the review backlog fits today.
  const { reviewQueue, overdueCount, heldBackCount } = useMemo(() => {
    const now = Date.now();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayTs = startOfToday.getTime();

    const matchesLang = (w: Word) => targetLanguage === 'Russe'
      ? (!w.target_lang || w.target_lang === 'Russe')
      : (w.target_lang === targetLanguage);

    // Mastered words are included too: they get rare maintenance reviews when due
    const due = words.filter(w => matchesLang(w) && w.next_review_at <= now);

    // Most overdue first — the closer a word is to being forgotten, the sooner it must appear
    const byOverdue = (a: Word, b: Word) => a.next_review_at - b.next_review_at;

    // Same-day retries ("forgotten" earlier today, due again in 1h) — highest priority
    const retries = due.filter(w => w.last_reviewed_at && w.last_reviewed_at >= todayTs).sort(byOverdue);
    // Seen words due for a scheduled review, most overdue first
    const seenDue = due.filter(w => w.last_reviewed_at && w.last_reviewed_at < todayTs).sort(byOverdue);
    // Brand-new words never shown before (oldest added first)
    const newWords = due.filter(w => !w.last_reviewed_at).sort((a, b) => a.created_at - b.created_at);

    const reviewedToday = words.filter(w => matchesLang(w) && w.last_reviewed_at && w.last_reviewed_at >= todayTs).length;
    const newIntroducedToday = words.filter(w => matchesLang(w) && w.first_reviewed_at && w.first_reviewed_at >= todayTs).length;

    // bonusCards = extra cards the learner explicitly requested beyond today's limit
    let budget = Math.max(0, DAILY_REVIEW_LIMIT + bonusCards - reviewedToday);

    const queue: Word[] = [];

    // Retries first, within the shared budget
    const retryTake = retries.slice(0, budget);
    queue.push(...retryTake);
    budget -= retryTake.length;

    // Then scheduled reviews of previously seen words
    const seenTake = seenDue.slice(0, budget);
    queue.push(...seenTake);
    budget -= seenTake.length;

    // New words enter only when the whole review backlog fits in today's budget
    const newBudget = Math.min(budget, Math.max(0, DAILY_NEW_LIMIT + bonusCards - newIntroducedToday));
    const newTake = newWords.slice(0, newBudget);
    queue.push(...newTake);

    // Review debt: due REVIEWS that did NOT fit into today's limit (drives the ⏰ indicator)
    const debt = (retries.length - retryTake.length) + (seenDue.length - seenTake.length);
    // Everything due but held back — how many more cards "continue anyway" could still show
    const heldBack = debt + (newWords.length - newTake.length);

    return { reviewQueue: queue, overdueCount: debt, heldBackCount: heldBack };
  }, [words, isReviewing, targetLanguage, clockTick, bonusCards]);

  const currentWord = sessionQueue[currentReviewIndex];

  const dailyStats = useMemo(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const timestamp = startOfToday.getTime();

    const reviewedToday = words.filter(w => {
      const matchesLang = targetLanguage === 'Russe'
        ? (!w.target_lang || w.target_lang === 'Russe')
        : (w.target_lang === targetLanguage);
      return matchesLang && w.last_reviewed_at && w.last_reviewed_at >= timestamp;
    }).length;
    // Total target = the daily limit, but never less than what's actually available today
    // (reviewed today + what's still queued). Capped at DAILY_REVIEW_LIMIT so it reads "X / 50".
    const totalToday = Math.min(DAILY_REVIEW_LIMIT, reviewedToday + reviewQueue.length);
    const progress = totalToday > 0 ? (reviewedToday / totalToday) * 100 : 0;

    return { reviewedToday, totalToday, progress };
  }, [words, reviewQueue, targetLanguage]);

  const masteredCount = useMemo(() => words.filter(w => {
    const matchesLang = targetLanguage === 'Russe' 
      ? (!w.target_lang || w.target_lang === 'Russe')
      : (w.target_lang === targetLanguage);
    return matchesLang && w.status === 'mastered';
  }).length, [words, targetLanguage]);
  const isDayComplete = reviewQueue.length === 0 && words.length > 0;

  // Where every word sits on the interval ladder, and a day-by-day forecast of the workload ahead.
  // Both are derived from the words themselves (review_count / next_review_at), so they are accurate
  // from day one and automatically reflect skipped days — a missed day just grows the backlog.
  const progressStats = useMemo(() => {
    const DAY = 1000 * 60 * 60 * 24;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const t0 = todayStart.getTime();

    const langWords = words.filter(w => targetLanguage === 'Russe'
      ? (!w.target_lang || w.target_lang === 'Russe')
      : w.target_lang === targetLanguage);

    // Ladder stage = the interval the word is currently waiting out.
    // review_count N means it was last scheduled with REVIEW_INTERVALS[N-1].
    const stageOf = (w: Word): number => {
      if (!w.last_reviewed_at) return -1;                    // never seen
      const c = w.review_count ?? 0;
      if (c === 0) return 0;                                  // reset by errors → back to 1 day
      if (c >= REVIEW_INTERVALS.length + 1) return REVIEW_INTERVALS.length; // mastered / maintenance
      return c - 1;                                           // 0→1j, 1→3j, 2→7j, 3→14j, 4→30j
    };

    const stages = [
      { label: 'Nouveau', days: null as number | null, color: 'bg-slate-300', count: 0 },
      ...REVIEW_INTERVALS.map(d => ({ label: `${d} j`, days: d, color: '', count: 0 })),
      { label: 'Appris', days: null as number | null, color: 'bg-emerald-500', count: 0 },
    ];
    const ladderColors = ['bg-red-400', 'bg-orange-400', 'bg-amber-400', 'bg-lime-400', 'bg-emerald-400'];
    REVIEW_INTERVALS.forEach((_, i) => { stages[i + 1].color = ladderColors[i]; });

    langWords.forEach(w => {
      const s = stageOf(w);
      stages[s + 1].count += 1;
    });

    const seenCount = langWords.filter(w => !!w.last_reviewed_at).length;
    const unseenCount = langWords.length - seenCount;

    // Forward simulation: replay the real daily rules (50/day, 15 new/day, most-overdue first),
    // assuming every review succeeds — the optimistic bound on how long the queue takes to clear.
    type Sim = { next: number; count: number; seen: boolean };
    const sim: Sim[] = langWords.map(w => ({
      next: w.next_review_at,
      count: w.review_count ?? 0,
      seen: !!w.last_reviewed_at,
    }));

    const HORIZON = 365;
    const forecast: { ts: number; load: number; backlog: number }[] = [];
    let allSeenDayIdx: number | null = null;
    let clearDayIdx: number | null = null;

    for (let d = 0; d < HORIZON; d++) {
      const dayEnd = t0 + (d + 1) * DAY - 1;
      const due = sim.filter(s => s.next <= dayEnd).sort((a, b) => a.next - b.next);
      const seenDue = due.filter(s => s.seen);
      const newDue = due.filter(s => !s.seen);

      let budget = DAILY_REVIEW_LIMIT;
      const takeSeen = seenDue.slice(0, budget);
      budget -= takeSeen.length;
      const takeNew = newDue.slice(0, Math.min(budget, DAILY_NEW_LIMIT));

      [...takeSeen, ...takeNew].forEach(s => {
        s.seen = true;
        const interval = s.count < REVIEW_INTERVALS.length
          ? REVIEW_INTERVALS[s.count]
          : Math.min(365, 30 * Math.pow(2, s.count - (REVIEW_INTERVALS.length - 1)));
        s.next = t0 + d * DAY + interval * DAY;
        s.count += 1;
      });

      const load = takeSeen.length + takeNew.length;
      const backlog = due.length - load;
      forecast.push({ ts: t0 + d * DAY, load, backlog });

      if (allSeenDayIdx === null && sim.every(s => s.seen)) allSeenDayIdx = d;
      if (clearDayIdx === null && backlog === 0 && allSeenDayIdx !== null) clearDayIdx = d;
    }

    return {
      total: langWords.length,
      seenCount,
      unseenCount,
      stages,
      forecast,
      allSeenDayIdx,
      clearDayIdx,
      horizon: HORIZON,
    };
    // Keyed on the calendar day, not on clockTick: a full-year simulation must not re-run every minute
  }, [words, targetLanguage, dayKey(new Date())]);

  const startReview = () => {
    setSessionQueue([...reviewQueue]);
    setCurrentReviewIndex(0);
    setShowTranslation(false);
    setCardCommit(null);
    setIsReviewing(true);
  };

  const stopReview = (pausedByUser = false) => {
    setIsReviewing(false);
    setSessionQueue([]);
    setCurrentReviewIndex(0);
    setShowTranslation(false);
    setCardCommit(null);
    setReviewPaused(pausedByUser);
  };

  const todayDate = useMemo(() => {
    return new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }, []);

  const searchResult = useMemo(() => {
    if (!searchQuery) return null;
    const q = searchQuery.trim().toLowerCase();
    const normalizedQuery = normalizeWord(q);
    const normalizedQueryNoArticle = normalizeWord(stripArticles(q));
    
    // Check if words exist
    if (words.length === 0) return null;

    // 1. First try exact normalized match on French word WITH current language
    const directMatch = words.find(w => 
      normalizeWord(w.word) === normalizedQuery && 
      (w.target_lang === targetLanguage || (!w.target_lang && targetLanguage === 'Russe'))
    );
    if (directMatch) return directMatch;

    // 2. Try match on translation (Current language word)
    const langMatch = words.find(w => 
      w.translation.toLowerCase().includes(q) && 
      (w.target_lang === targetLanguage || (!w.target_lang && targetLanguage === 'Russe'))
    );
    if (langMatch) return langMatch;

    // 3. Try match ignoring articles
    const matchNoArticle = words.find(w => normalizeWord(stripArticles(w.word)) === normalizedQueryNoArticle && (w.target_lang === targetLanguage || (!w.target_lang && targetLanguage === 'Russe')));
    if (matchNoArticle) return matchNoArticle;

    return null;
  }, [searchQuery, words, targetLanguage]);

  // Fetch translation and save automatically
  const fetchTranslation = useCallback(async (query: string) => {
    const trimmedQuery = query.trim().toLowerCase();
    const normalizedQuery = normalizeWord(trimmedQuery);

    if (!trimmedQuery || trimmedQuery.length < 2) return;
    if (lastFetchedQuery.current === trimmedQuery) return;

    lastFetchedQuery.current = trimmedQuery;
    setIsSearching(true);
    setError(null);
    setSuggestions([]);
    setCollocations([]);
    setCollocationsFor('');

    // A slow/overloaded service must NOT be reported as "word not found" — that sends the
    // learner hunting for a dictionary problem that doesn't exist.
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      setIsSearching(false);
      setError(`Le service de traduction est surchargé. Réessayez — le mot "${trimmedQuery}" n'est probablement pas en cause.`);
    }, 30000);

    try {
      // Robust API key detection in frontend
      const apiKey = process.env.GEMINI_API_KEY || (window as any).GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("Clé API не найдена. Пожалуйста, проверьте настройки (Secrets) в AI Studio.");
      }

      // Detect script: Cyrillic → user is typing in their native language → translate TO French
      const hasCyrillic = /[Ѐ-ӿ]/.test(query.trim());
      const prompt = hasCyrillic
        ? `The user typed "${query.trim()}" in ${currentLangObj.aiName} (Cyrillic script).
Translate this ${currentLangObj.aiName} word or phrase into French.
Return ONLY a raw JSON object, no markdown, no extra text:
{"frenchWord":"the French translation","translation":"${query.trim()}","gender":"m/f/none","isPlural":false,"infinitive":"","infinitiveTranslation":"","example":"short French sentence using the word","exampleTranslation":"translation of example in ${currentLangObj.aiName}","found":true,"suggestions":[]}`
        : `Translate the word or phrase "${trimmedQuery}" between French and ${currentLangObj.aiName}.
If it's French, translate to ${currentLangObj.aiName}. If it's ${currentLangObj.aiName}, translate to French.

Translation rule:
- For a SINGLE word: give a short accurate translation (1-4 words).
- For a PHRASE or SENTENCE: translate the WHOLE phrase completely — never just one word from it.

Part of speech:
- If "frenchWord" is a VERB (any form, conjugated or already infinitive), ALWAYS fill "infinitive" with its infinitive form. If the word is already the infinitive, set "infinitive" to the SAME word (do not leave it empty).
- Always fill "infinitiveTranslation" too when "infinitive" is set.
- If "frenchWord" is NOT a verb, leave "infinitive" and "infinitiveTranslation" empty.

Collocations — the most valuable part for the learner:
- Fill "collocations" with 4 SHORT, genuinely common French expressions built around "frenchWord" (2-5 words each).
- Prefer what a native actually says: fixed expressions, verb+noun pairs, common prepositions.
- Each item: {"phrase": "the French collocation", "translation": "its meaning in ${currentLangObj.aiName}"}.
- Keep "frenchWord" (or its inflected form) inside every phrase. No full sentences, no punctuation at the end.

If the word has a typo or is misspelled (only for French words), set found:false and put 2-3 correct French spelling suggestions in "suggestions".
If valid, translate it. Output ONLY a raw JSON object, no markdown, no extra text:
{"frenchWord":"...","translation":"complete accurate translation in ${currentLangObj.aiName}","gender":"m/f/none","isPlural":false,"infinitive":"","infinitiveTranslation":"","example":"short French sentence","exampleTranslation":"translation in ${currentLangObj.aiName}","found":true,"suggestions":[],"collocations":[{"phrase":"...","translation":"..."}]}`;

      const ai = new GoogleGenAI({ apiKey });
      const response = await generateWithFallback(ai, {
        contents: prompt,
        config: {}
      });
      const result = JSON.parse(extractJson(response) || '{}');

      // A late but valid answer is better than a stale timeout message — accept it and clear the error
      if (timedOut && result.found && result.frenchWord && result.translation) {
        setError(null);
      } else if (timedOut) {
        return; // late AND unusable — keep the timeout message
      }

      if (result.found && result.frenchWord && result.translation) {
        const finalWord = result.frenchWord;
        const normalizedFinal = normalizeWord(finalWord);

        // Collocations come free with the same call — show them under the result
        if (Array.isArray(result.collocations)) {
          const cleaned = result.collocations
            .filter((c: any) => c && typeof c.phrase === 'string' && c.phrase.trim() && typeof c.translation === 'string')
            .map((c: any) => ({ phrase: c.phrase.trim(), translation: c.translation.trim() }))
            .filter((c: any) => normalizeWord(c.phrase) !== normalizedFinal)
            .slice(0, 6);
          if (cleaned.length > 0) {
            setCollocations(cleaned);
            setCollocationsFor(finalWord);
          }
        }

        const newWord: Word = {
          id: crypto.randomUUID(),
          word: finalWord,
          translation: result.translation,
          target_lang: targetLanguage,
          gender: result.gender as any,
          isPlural: result.isPlural,
          infinitive: result.infinitive,
          infinitiveTranslation: result.infinitiveTranslation,
          example: result.example,
          exampleTranslation: result.exampleTranslation,
          tags: 'Auto-added',
          created_at: Date.now(),
          next_review_at: Date.now() + NEW_WORD_FIRST_DELAY, // learning step: first review in ~10 min
          status: 'new',
          review_count: 0
        };

        setWords(prev => {
          const existingIdx = prev.findIndex(w => normalizeWord(w.word) === normalizedFinal);
          if (existingIdx !== -1) {
            // Update existing word with new language translation
            const updated = [...prev];
            updated[existingIdx] = {
              ...updated[existingIdx],
              translation: result.translation,
              target_lang: targetLanguage,
              // preserve status if possible or reset if it's a completely different language logic
              // let's keep progress for now as per user's "just option to choose another language"
              gender: result.gender as any || updated[existingIdx].gender,
              isPlural: result.isPlural ?? updated[existingIdx].isPlural,
              infinitive: result.infinitive || updated[existingIdx].infinitive,
              infinitiveTranslation: result.infinitiveTranslation || updated[existingIdx].infinitiveTranslation,
              example: result.example || updated[existingIdx].example,
              exampleTranslation: result.exampleTranslation || updated[existingIdx].exampleTranslation,
            };
            return updated;
          }
          return [...prev, newWord];
        });
        
        if (result.suggestions && result.suggestions.length > 0) {
          setSuggestions(result.suggestions);
        }
      } else if (result.found === false && Array.isArray(result.suggestions) && result.suggestions.length > 0) {
        setSuggestions(result.suggestions);
        setError(`Le mot "${trimmedQuery}" n'a pas été trouvé. Vouliez-vous dire :`);
      } else {
        // Answer came back but unusable (missing fields, or found:false with no suggestions).
        // Say so instead of leaving the screen silently stuck.
        lastFetchedQuery.current = ''; // allow an immediate retry of the same word
        setError(`Réponse incomplète du service pour "${trimmedQuery}". Réessayez.`);
      }
    } catch (err: any) {
      console.error("Translation error:", err);
      const raw = String(err?.message || '');
      const code = (() => { try { return JSON.parse(raw)?.error?.code; } catch { return null; } })();
      lastFetchedQuery.current = ''; // a failed call must not block retrying the same word
      setError(
        code === 429 ? "Quota de traduction épuisé pour aujourd'hui. Réessayez plus tard."
        : code === 503 || code === 500 ? "Le service de traduction est momentanément surchargé. Réessayez."
        : `Erreur: ${err.message || 'Erreur inconnue'}`
      );
    } finally {
      clearTimeout(timeoutId);
      setIsSearching(false);
    }
  }, [targetLanguage, currentLangObj.aiName, words, normalizeWord]);

  const triggerSearch = useCallback(() => {
    if (searchQuery.trim().length >= 2 && !searchResult) {
      fetchTranslation(searchQuery);
    }
  }, [searchQuery, searchResult, fetchTranslation]);

  // Load (or extend) the list of collocations for the word currently shown in the dictionary
  const fetchCollocations = async (word: Word) => {
    if (isLoadingCollocations) return;
    setIsLoadingCollocations(true);
    try {
      const apiKey = process.env.GEMINI_API_KEY || (window as any).GEMINI_API_KEY;
      if (!apiKey) throw new Error("Clé API introuvable");
      const ai = new GoogleGenAI({ apiKey });
      const already = collocationsFor === word.word ? collocations.map(c => c.phrase) : [];
      const response = await generateWithFallback(ai, {
        contents: `Donne 4 expressions françaises COURANTES construites autour du mot "${word.word}" (${word.translation}).

Règles :
- 2 à 5 mots par expression, courtes et vraiment usuelles (ce qu'un natif dit réellement).
- Le mot "${word.word}" (ou sa forme fléchie/conjuguée) doit figurer dans chaque expression.
- Pas de phrase complète, pas de ponctuation finale.
${already.length > 0 ? `- N'utilise AUCUNE de ces expressions déjà proposées : ${already.join(' ; ')}` : ''}

Réponds UNIQUEMENT avec un JSON brut, sans markdown :
{"collocations":[{"phrase":"...","translation":"sens en ${currentLangObj.aiName}"}]}`,
        config: {}
      });
      const result = JSON.parse(extractJson(response) || '{}');
      if (!Array.isArray(result.collocations)) throw new Error('bad response');
      const seen = new Set([normalizeWord(word.word), ...already.map(p => normalizeWord(p))]);
      const fresh = result.collocations
        .filter((c: any) => c && typeof c.phrase === 'string' && c.phrase.trim() && typeof c.translation === 'string')
        .map((c: any) => ({ phrase: c.phrase.trim(), translation: c.translation.trim() }))
        .filter((c: { phrase: string }) => {
          const k = normalizeWord(c.phrase);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      setCollocations(prev => (collocationsFor === word.word ? [...prev, ...fresh] : fresh));
      setCollocationsFor(word.word);
    } catch (e) {
      console.error('Collocations error:', e);
      alert("Impossible de charger les expressions. Réessayez.");
    } finally {
      setIsLoadingCollocations(false);
    }
  };

  // Save a collocation as its own entry — this is the "learn in context" path:
  // the phrase enters the base, not just the bare word
  const saveCollocation = (c: { phrase: string; translation: string }, source: Word) => {
    const normalizedPhrase = normalizeWord(c.phrase);
    setWords(prev => {
      if (prev.some(w => normalizeWord(w.word) === normalizedPhrase)) return prev;
      const entry: Word = {
        id: crypto.randomUUID(),
        word: c.phrase,
        translation: c.translation,
        target_lang: targetLanguage,
        gender: 'none',
        isPlural: false,
        infinitive: source.infinitive,
        infinitiveTranslation: source.infinitiveTranslation,
        example: '',
        exampleTranslation: '',
        tags: 'Expression',
        created_at: Date.now(),
        next_review_at: Date.now() + NEW_WORD_FIRST_DELAY,
        status: 'new',
        review_count: 0,
      };
      return [...prev, entry];
    });
    setSavedCollocations(prev => new Set(prev).add(normalizedPhrase));
    speak(c.phrase);
  };

  // Auto-search with 2s debounce after user stops typing
  useEffect(() => {
    if (!searchQuery) {
      lastFetchedQuery.current = '';
      setIsSearching(false);
      setError(null);
      setSuggestions([]);
      return;
    }
    if (searchResult) {
      setIsSearching(false);
      return;
    }
    const timer = setTimeout(() => {
      fetchTranslation(searchQuery);
    }, 2000);
    return () => clearTimeout(timer);
  }, [searchQuery, searchResult, fetchTranslation]);

  // Auto-start review if words are due, or refresh if language changes
  useEffect(() => {
    if (reviewQueue.length > 0 && !isReviewing && !reviewPaused) {
      startReview();
    } else if (isReviewing && sessionQueue.length > 0) {
      // If language changed while in review, we might want to refresh the queue
      const allMatch = sessionQueue.every(w => {
        return targetLanguage === 'Russe' 
          ? (!w.target_lang || w.target_lang === 'Russe')
          : (w.target_lang === targetLanguage);
      });
      
      if (!allMatch) {
        setSessionQueue([...reviewQueue]);
        setCurrentReviewIndex(0);
        if (reviewQueue.length === 0) setIsReviewing(false);
      }
    }
  }, [reviewQueue, isReviewing, reviewPaused, targetLanguage, sessionQueue.length]);

  // The SRS ladder advances one fixed step per review — 1d → 3d → 7d → 14d → 30d → mastered
  // (maintenance 60/120/240/365d). Self-assessment does NOT set the interval: it is unreliable,
  // so its only job is `last_grade`, which routes the word into an activity tier
  // (forgotten → almost → remembered). The brake lives in the activities: an objectively wrong
  // answer there knocks the word back down the ladder (see resolveExerciseAnswer).
  const applyGrade = (w: Word, grade: ReviewGrade): Word => {
    const DAY = 1000 * 60 * 60 * 24;
    let nextReview = Date.now();
    let status: Word['status'] = 'learning';
    let reviewCount = w.review_count;

    if (reviewCount < REVIEW_INTERVALS.length) {
      nextReview += DAY * REVIEW_INTERVALS[reviewCount];
    } else {
      const maintenanceDays = Math.min(365, 30 * Math.pow(2, reviewCount - (REVIEW_INTERVALS.length - 1)));
      nextReview += DAY * maintenanceDays;
      status = 'mastered';
    }
    reviewCount += 1;

    if (status === 'mastered' && w.status !== 'mastered') {
      setJustMastered(w.word);
      setTimeout(() => setJustMastered(null), 3000);
    }

    return {
      ...w,
      next_review_at: nextReview,
      status,
      review_count: reviewCount,
      last_grade: grade, // drives activity tier only
      last_reviewed_at: Date.now(),
      first_reviewed_at: w.first_reviewed_at ?? Date.now(),
    };
  };

  const handleReview = (grade: ReviewGrade) => {
    if (!currentWord || !isReviewing) return;

    const updatedWords = words.map(w => (w.id === currentWord.id ? applyGrade(w, grade) : w));

    setWords(updatedWords);
    setShowTranslation(false);
    setCardCommit(null);
    recordActivity();

    if (currentReviewIndex + 1 < sessionQueue.length) {
      setCurrentReviewIndex(prev => prev + 1);
    } else {
      stopReview();
    }
  };

  const handleBulkAdd = async () => {
    if (!bulkText.trim()) return;
    await processRawTextWithAI(bulkText);
    setBulkText('');
  };

  const processRawTextWithAI = async (text: string) => {
    setIsUploading(true);
    setError(null);
    try {
      const apiKey = process.env.GEMINI_API_KEY || (window as any).GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("Clé API не найдена.");
      }

      const ai = new GoogleGenAI({ apiKey });
      const response = await generateWithFallback(ai, {
        contents: `Extract French vocabulary from the following text: ${text.substring(0, 5000)}.
        Identify word, translation in ${targetLanguage}, gender (m/f/none), isPlural, infinitive, and examples.
        If a word is a verb, always fill "infinitive" (use the same word if it's already the infinitive) and "infinitiveTranslation". If it's not a verb, leave both empty.
        Respond ONLY with a JSON array of objects. No reasoning allowed.`,
        config: {}
      });

      const result = JSON.parse(extractJson(response) || '[]');
      if (Array.isArray(result) && result.length > 0) {
        const validItems = result.filter(item =>
          item && typeof item.word === 'string' && item.word.trim() &&
          typeof item.translation === 'string' && item.translation.trim()
        );
        const newWords: Word[] = validItems.map(item => ({
          id: crypto.randomUUID(),
          word: item.word.trim(),
          translation: item.translation.trim(),
          gender: item.gender,
          isPlural: item.isPlural,
          infinitive: item.infinitive?.trim(),
          infinitiveTranslation: item.infinitiveTranslation?.trim(),
          example: item.example?.trim() || '',
          exampleTranslation: item.exampleTranslation?.trim() || '',
          target_lang: targetLanguage,
          tags: 'Imported',
          created_at: Date.now(),
          next_review_at: Date.now() + NEW_WORD_FIRST_DELAY, // learning step: first review in ~10 min
          status: 'new',
          review_count: 0
        }));

        setWords(prev => {
          const existingNormalizedWords = new Set(prev.map(w => normalizeWord(w.word)));
          const uniqueNewWords = newWords.filter(w => {
            const norm = normalizeWord(w.word);
            if (existingNormalizedWords.has(norm)) return false;
            existingNormalizedWords.add(norm);
            return true;
          });
          return [...prev, ...uniqueNewWords];
        });
      }
    } catch (err) {
      console.error("AI Import error:", err);
      const errorMsg = err instanceof Error ? err.message : "Inconnue";
      setError(`Erreur d'analyse IA (${errorMsg}). Veuillez réessayer.`);
    } finally {
      setIsUploading(false);
      setIsUploadModalOpen(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so the same file can be selected again
    if (!file) return;

    const fileType = file.name.split('.').pop()?.toLowerCase();
    let extractedText = "";

    try {
      if (fileType === 'xlsx' || fileType === 'xls') {
        const XLSX = await import('xlsx');
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data);
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        extractedText = XLSX.utils.sheet_to_txt(firstSheet);
      } else if (fileType === 'docx') {
        const mammoth = (await import('mammoth')).default;
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        extractedText = result.value;
      } else if (fileType === 'pdf') {
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        let fullText = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          fullText += content.items.map((item: any) => item.str).join(" ") + "\n";
        }
        extractedText = fullText;
      } else if (fileType === 'csv' || fileType === 'txt') {
        extractedText = await file.text();
      } else {
        setError("Format de fichier non supporté.");
        return;
      }

      if (extractedText.trim()) {
        await processRawTextWithAI(extractedText);
      } else {
        setError("Le fichier semble vide.");
      }
    } catch (err) {
      console.error("File processing error:", err);
      setError("Erreur lors de la lecture du fichier.");
    }
  };

  return (
    <div className="min-h-screen bg-[#FDFCFB] text-slate-900 font-sans selection:bg-indigo-100">
      {/* Error Notifications */}
      <AnimatePresence>
        {syncError && (
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-20 left-1/2 -translate-x-1/2 z-[100] w-full max-w-md px-4"
          >
            <div className="bg-red-50 border border-red-200 p-4 rounded-2xl shadow-xl flex items-start gap-3">
              <AlertCircle className="text-red-500 shrink-0" size={20} />
              <div className="flex-1">
                <p className="text-sm font-bold text-red-700">Проблема с базой данных</p>
                <p className="text-xs text-red-600 mt-1">{syncError}</p>
                <button 
                  onClick={() => window.location.reload()}
                  className="mt-2 text-[10px] font-bold uppercase text-red-700 hover:underline"
                >
                  Обновить страницу
                </button>
              </div>
              <button onClick={() => setSyncError(null)} className="text-red-400">
                <X size={16} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-200">
              <Languages size={24} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-900">Francabulaire</h1>
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Apprendre et mémoriser</p>
              </div>
            </div>
          </div>
          
          <div className="hidden md:flex items-center gap-8 text-sm font-medium text-slate-600">
            <div className="flex flex-col gap-1.5 w-48">
              <div className="flex justify-between text-[10px] font-bold uppercase tracking-tighter">
                <span className="text-slate-400">Progression Quotidienne</span>
                <span className="flex items-center gap-2">
                  {overdueCount > 0 && <span className="text-red-500" title={`${overdueCount} révisions en retard — les nouveaux mots attendent que ce retard soit rattrapé`}>⏰ {overdueCount}</span>}
                  {streak > 0 && <span className="text-orange-500" title={`${streak} jours d'affilée`}>🔥 {streak}</span>}
                  <span className="text-indigo-600">{dailyStats.reviewedToday} / {dailyStats.totalToday}</span>
                </span>
              </div>
              <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                <motion.div 
                  initial={false}
                  animate={{ width: `${dailyStats.progress}%` }}
                  className="h-full bg-indigo-500 rounded-full"
                />
              </div>
            </div>

            <div className="flex items-center gap-6">
              <button 
                onClick={() => setIsWordListModalOpen(true)}
                className="flex flex-col items-end hover:bg-slate-50 p-1 px-2 rounded-lg transition-colors"
              >
                <span className="text-slate-400 text-[10px] uppercase tracking-widest">Total mots</span>
                <span className="text-slate-900 font-bold">{words.length}</span>
              </button>
              <div className="flex flex-col items-end">
                <span className="text-slate-400 text-[10px] uppercase tracking-widest">Appris</span>
                <span className="text-emerald-600 font-bold">{masteredCount}</span>
              </div>
            </div>
            <div className="h-8 w-px bg-slate-200" />

            <button 
              onClick={() => setIsUploadModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl hover:bg-white hover:border-indigo-300 hover:text-indigo-600 transition-all text-xs font-bold uppercase tracking-tight"
            >
              <Upload size={16} />
              Importer
            </button>

            <div className="h-8 w-px bg-slate-200" />

            <div className="relative group">
              {user ? (
                <div className="flex items-center gap-3">
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] text-slate-400 uppercase font-bold tracking-widest">Connecté</span>
                    <span className="text-xs font-bold text-slate-700">{user.displayName}</span>
                  </div>
                  <div className="relative">
                    <button 
                      onClick={handleLogout}
                      className="w-10 h-10 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center hover:bg-red-50 hover:text-red-500 transition-all border border-indigo-100 hover:border-red-100"
                      title="Se déconnecter"
                    >
                      <UserIcon size={20} />
                    </button>
                    <div className="absolute -bottom-1 -right-1">
                      {isSyncing ? (
                        <div className="w-4 h-4 bg-white rounded-full flex items-center justify-center shadow-sm">
                          <Cloud className="text-indigo-400 animate-pulse" size={10} />
                        </div>
                      ) : (
                        <div className="w-4 h-4 bg-white rounded-full flex items-center justify-center shadow-sm">
                          <Cloud className="text-emerald-500" size={10} />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <button 
                  onClick={handleLogin}
                  disabled={isLoggingIn}
                  className="w-10 h-10 bg-white border border-slate-200 rounded-full flex items-center justify-center hover:border-indigo-300 hover:text-indigo-600 transition-all disabled:opacity-50"
                  title="Se connecter"
                >
                  {isLoggingIn ? (
                    <Loader2 size={20} className="animate-spin" />
                  ) : (
                    <UserIcon size={20} />
                  )}
                </button>
              )}
              
              {error && (error.includes("connexion") || error.includes("Firebase")) && (
                <div className="absolute top-full mt-2 right-0 w-64 p-3 bg-red-50 border border-red-100 rounded-xl shadow-xl z-50">
                  <p className="text-[10px] text-red-600 font-bold leading-tight">{error}</p>
                </div>
              )}
            </div>
          </div>

          {/* Mobile Menu Toggle */}
          <div className="md:hidden flex items-center gap-4">
            {user && (
              <div className="relative">
                <div className="w-8 h-8 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center border border-indigo-100">
                  <UserIcon size={16} />
                </div>
                <div className="absolute -bottom-1 -right-1">
                  <Cloud className={isSyncing ? "text-indigo-400 animate-pulse" : "text-emerald-500"} size={8} />
                </div>
              </div>
            )}
            <button 
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="p-2 text-slate-600 hover:bg-slate-50 rounded-lg transition-all"
            >
              {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
            </button>
          </div>
        </div>

        {/* Mobile Menu */}
        <AnimatePresence>
          {isMobileMenuOpen && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="md:hidden border-t border-slate-100 bg-white overflow-hidden"
            >
              <div className="px-6 py-6 space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <button 
                    onClick={() => {
                      setIsMobileMenuOpen(false);
                      setIsWordListModalOpen(true);
                    }}
                    className="bg-slate-50 p-3 rounded-2xl text-left hover:bg-slate-100 transition-colors"
                  >
                    <span className="text-slate-400 text-[10px] uppercase tracking-widest block mb-1">Total mots</span>
                    <span className="text-slate-900 font-bold text-lg">{words.length}</span>
                  </button>
                  <div className="bg-emerald-50 p-3 rounded-2xl">
                    <span className="text-slate-400 text-[10px] uppercase tracking-widest block mb-1">Appris</span>
                    <span className="text-emerald-600 font-bold text-lg">{masteredCount}</span>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between text-[10px] font-bold uppercase tracking-tighter">
                    <span className="text-slate-400">Progression Quotidienne</span>
                    <span className="text-indigo-600">{dailyStats.reviewedToday} / {dailyStats.totalToday}</span>
                  </div>
                  <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                    <motion.div 
                      initial={false}
                      animate={{ width: `${dailyStats.progress}%` }}
                      className="h-full bg-indigo-500 rounded-full"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-3 pt-2">
                  <button 
                    onClick={() => {
                      setIsUploadModalOpen(true);
                      setIsMobileMenuOpen(false);
                    }}
                    className="flex items-center justify-center gap-2 w-full py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold uppercase tracking-tight"
                  >
                    <Upload size={18} />
                    Importer
                  </button>
                  
                  {user ? (
                    <button 
                      onClick={() => {
                        handleLogout();
                        setIsMobileMenuOpen(false);
                      }}
                      className="flex items-center justify-center gap-2 w-full py-3 bg-red-50 text-red-600 border border-red-100 rounded-xl text-sm font-bold uppercase tracking-tight"
                    >
                      <LogOut size={18} />
                      Se déconnecter
                    </button>
                  ) : (
                    <button 
                      onClick={() => {
                        handleLogin();
                        setIsMobileMenuOpen(false);
                      }}
                      className="flex items-center justify-center gap-2 w-full py-3 bg-indigo-600 text-white rounded-xl text-sm font-bold uppercase tracking-tight"
                    >
                      <LogIn size={18} />
                      Se connecter
                    </button>
                  )}

                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:items-stretch">

          {/* Right Section: Flashcards (dictionary is on the left) */}
          <section id="flashcards-section" className="order-2 lg:col-span-7 space-y-6 flex flex-col">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <RotateCcw size={18} className="text-indigo-600" />
                Révision
              </h2>
              {isReviewing && (
                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                    {currentReviewIndex + 1} / {sessionQueue.length}
                  </span>
                  <button
                    onClick={() => stopReview(true)}
                    className="px-3 py-1.5 bg-slate-100 text-slate-600 rounded-lg text-xs font-bold uppercase tracking-tight hover:bg-slate-200 transition-colors"
                  >
                    Arrêter
                  </button>
                </div>
              )}
            </div>

            {/* Activity buttons (mobile row) */}
            <div className="flex lg:hidden items-center justify-center gap-3">
              <button onClick={startReversePractice} className="w-11 h-11 bg-white border-2 border-purple-100 text-purple-500 rounded-xl flex items-center justify-center shadow-sm active:scale-95 transition-all" title="Rappel actif">
                <Languages size={20} />
              </button>
              <button onClick={startMatchGame} className="w-11 h-11 bg-white border-2 border-indigo-100 text-indigo-500 rounded-xl flex items-center justify-center shadow-sm active:scale-95 transition-all" title="Relier les mots">
                <Grid2X2 size={20} />
              </button>
              <button onClick={openTextExercise} className="w-11 h-11 bg-white border-2 border-indigo-100 text-indigo-500 rounded-xl flex items-center justify-center shadow-sm active:scale-95 transition-all" title="Phrases à compléter">
                <FileText size={20} />
              </button>
              <button onClick={startQuizGame} className="w-11 h-11 bg-white border-2 border-emerald-100 text-emerald-500 rounded-xl flex items-center justify-center shadow-sm active:scale-95 transition-all" title="Quiz">
                <CheckCircle2 size={20} />
              </button>
              <button onClick={startTypingActivity} className="w-11 h-11 bg-white border-2 border-amber-100 text-amber-500 rounded-xl flex items-center justify-center shadow-sm active:scale-95 transition-all" title="Écrivez le mot">
                <Keyboard size={20} />
              </button>
              <button onClick={startComposeActivity} className="w-11 h-11 bg-white border-2 border-rose-100 text-rose-500 rounded-xl flex items-center justify-center shadow-sm active:scale-95 transition-all" title="Composez une phrase">
                <Edit2 size={20} />
              </button>
              <button onClick={startComboSession} className="w-11 h-11 bg-gradient-to-br from-indigo-500 to-purple-500 text-white rounded-xl flex items-center justify-center shadow-sm active:scale-95 transition-all" title="Session complète : les 6 activités à la suite">
                <Zap size={20} />
              </button>
            </div>

            <div className="relative flex-1 flex">
              {/* Activity bookmark tabs (desktop) */}
              <div className="hidden lg:flex flex-col gap-2 absolute top-1/2 -translate-y-1/2 right-0 translate-x-1/2 z-20">
                <button
                  onClick={startReversePractice}
                  className="w-11 h-11 bg-white border-2 border-purple-100 text-purple-500 rounded-xl flex items-center justify-center shadow-md hover:bg-purple-50 hover:border-purple-300 hover:scale-105 transition-all active:scale-95"
                  title="Rappel actif : traduction → français"
                >
                  <Languages size={20} />
                </button>
                <button
                  onClick={startMatchGame}
                  className="w-11 h-11 bg-white border-2 border-indigo-100 text-indigo-500 rounded-xl flex items-center justify-center shadow-md hover:bg-indigo-50 hover:border-indigo-300 hover:scale-105 transition-all active:scale-95"
                  title="Relier les mots"
                >
                  <Grid2X2 size={20} />
                </button>
                <button
                  onClick={openTextExercise}
                  className="w-11 h-11 bg-white border-2 border-indigo-100 text-indigo-500 rounded-xl flex items-center justify-center shadow-md hover:bg-indigo-50 hover:border-indigo-300 hover:scale-105 transition-all active:scale-95"
                  title="Phrases à compléter"
                >
                  <FileText size={20} />
                </button>
                <button
                  onClick={startQuizGame}
                  className="w-11 h-11 bg-white border-2 border-emerald-100 text-emerald-500 rounded-xl flex items-center justify-center shadow-md hover:bg-emerald-50 hover:border-emerald-300 hover:scale-105 transition-all active:scale-95"
                  title="Quiz : choisissez la bonne traduction"
                >
                  <CheckCircle2 size={20} />
                </button>
                <button
                  onClick={startTypingActivity}
                  className="w-11 h-11 bg-white border-2 border-amber-100 text-amber-500 rounded-xl flex items-center justify-center shadow-md hover:bg-amber-50 hover:border-amber-300 hover:scale-105 transition-all active:scale-95"
                  title="Écrivez le mot : tapez le mot français"
                >
                  <Keyboard size={20} />
                </button>
                <button
                  onClick={startComposeActivity}
                  className="w-11 h-11 bg-white border-2 border-rose-100 text-rose-500 rounded-xl flex items-center justify-center shadow-md hover:bg-rose-50 hover:border-rose-300 hover:scale-105 transition-all active:scale-95"
                  title="Composez une phrase avec le mot — l'IA vérifie"
                >
                  <Edit2 size={20} />
                </button>
                <button
                  onClick={startComboSession}
                  className="w-11 h-11 bg-gradient-to-br from-indigo-500 to-purple-500 text-white rounded-xl flex items-center justify-center shadow-md hover:scale-105 transition-all active:scale-95"
                  title="Session complète : les 6 activités à la suite (55 mots)"
                >
                  <Zap size={20} />
                </button>
              </div>

            <div className="bg-white border border-slate-200 rounded-3xl p-8 min-h-[400px] flex-1 flex flex-col items-center justify-center relative overflow-hidden shadow-sm">
              <AnimatePresence>
                {justMastered && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.5, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 1.5 }}
                    className="absolute top-10 z-20 flex flex-col items-center gap-2"
                  >
                    <div className="px-4 py-2 bg-emerald-500 text-white rounded-2xl shadow-xl shadow-emerald-200 flex items-center gap-2">
                      <CheckCircle2 size={20} />
                      <span className="font-bold uppercase tracking-widest text-sm">Appris !</span>
                    </div>
                    <p className="text-xs font-bold text-emerald-600 uppercase tracking-tighter">"{justMastered}" est maîtrisé</p>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence mode="wait">
                {!isReviewing ? (
                  <motion.div 
                    key="idle"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="text-center space-y-4"
                  >
                    <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mx-auto text-slate-300">
                      <BookOpen size={40} />
                    </div>
                    <div>
                      <h3 className="text-xl font-bold text-slate-800">Prêt pour aujourd'hui ?</h3>
                      <p className="text-slate-500 max-w-xs mx-auto mt-2">
                        {reviewQueue.length > 0
                          ? `Vous avez ${reviewQueue.length} mots qui attendent d'être révisés.`
                          : "Excellent ! Vous avez révisé tous vos mots pour le moment."}
                      </p>
                    </div>
                    {reviewPaused && reviewQueue.length > 0 && (
                      <button
                        onClick={() => setReviewPaused(false)}
                        className="px-8 py-3 bg-indigo-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 flex items-center gap-2 mx-auto"
                      >
                        <RotateCcw size={16} />
                        Reprendre la révision
                      </button>
                    )}

                    {/* Daily limit reached but more words are waiting — let the learner go past it */}
                    {reviewQueue.length === 0 && heldBackCount > 0 && (
                      <div className="space-y-2">
                        <button
                          onClick={() => { setBonusCards(b => b + 20); setReviewPaused(false); }}
                          className="px-8 py-3 bg-indigo-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 flex items-center gap-2 mx-auto"
                        >
                          <Plus size={16} />
                          Encore {Math.min(20, heldBackCount)} cartes
                        </button>
                        <p className="text-[11px] text-slate-400 max-w-xs mx-auto">
                          Limite du jour atteinte — {heldBackCount} mots attendent encore.
                        </p>
                      </div>
                    )}
                  </motion.div>
                ) : (
                  <motion.div 
                    key={currentWord?.id}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 1.05 }}
                    className="w-full flex flex-col items-center gap-8"
                  >
                    <div className="text-center space-y-4">
                      <div className="flex items-center justify-center gap-2">
                        <span className="px-3 py-1 bg-indigo-50 text-indigo-600 text-[10px] font-bold uppercase tracking-widest rounded-full">
                          Mot {currentReviewIndex + 1} sur {sessionQueue.length}
                        </span>
                        {(currentWord?.review_count ?? 0) >= 2 && (
                          <span className="px-3 py-1 bg-purple-50 text-purple-600 text-[10px] font-bold uppercase tracking-widest rounded-full" title="Rappel actif : retrouvez le mot français">
                            {currentLangObj.flag} → 🇫🇷
                          </span>
                        )}
                      </div>
                        <div className="flex items-center justify-center gap-4">
                          <h3 className="text-3xl sm:text-4xl md:text-5xl font-black text-slate-900 tracking-tight break-words">
                            {(currentWord?.review_count ?? 0) >= 2
                              ? currentWord?.translation
                              : getWordWithArticle(currentWord?.word || '', currentWord?.gender, currentWord?.isPlural)}
                          </h3>
                          <div className="flex flex-col gap-2">
                            {((currentWord?.review_count ?? 0) < 2 || showTranslation) && (
                              <button
                                onClick={() => speak(currentWord?.word || '')}
                                className={`p-2 rounded-full transition-all ${
                                  isSpeaking
                                    ? 'bg-indigo-600 text-white scale-110 shadow-lg shadow-indigo-200'
                                    : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
                                }`}
                                title="Écouter la prononciation"
                              >
                                <Volume2 size={24} className={isSpeaking ? 'animate-pulse' : ''} />
                              </button>
                            )}
                            <div className="flex flex-col gap-1">
                              {((currentWord?.review_count ?? 0) < 2 || showTranslation) && (
                                <>
                                  {currentWord?.gender && currentWord.gender !== 'none' && (
                                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase text-center ${
                                      currentWord.gender === 'm' ? 'bg-blue-100 text-blue-600' : 'bg-pink-100 text-pink-600'
                                    }`}>
                                      {currentWord.gender === 'm' ? 'masc' : 'fém'}
                                    </span>
                                  )}
                                  {currentWord?.infinitive && (
                                    <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase text-center bg-purple-100 text-purple-600">
                                      Verbe
                                    </span>
                                  )}
                                </>
                              )}
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase text-center ${
                                currentWord?.status === 'mastered' ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'
                              }`}>
                                {currentWord?.status === 'mastered' ? 'Appris' : 'En cours'}
                              </span>
                            </div>
                          </div>
                        </div>
                      {currentWord?.example && ((currentWord?.review_count ?? 0) < 2 || showTranslation) && (
                        <div className="space-y-1">
                          <p className="text-slate-500 italic text-base sm:text-lg max-w-md inline-flex items-start gap-1.5">
                            <span>"{cleanExample(currentWord.example)}"</span>
                            <button
                              onClick={() => speak(cleanExample(currentWord.example))}
                              className="p-1 mt-0.5 text-indigo-300 hover:text-indigo-600 transition-colors shrink-0"
                              title="Écouter la phrase"
                            >
                              <Volume2 size={16} />
                            </button>
                          </p>
                          {currentWord?.infinitive && normalizeWord(currentWord.infinitive) !== normalizeWord(currentWord.word) && (
                            <p className="text-indigo-500/40 text-[10px] font-bold mt-1 uppercase tracking-tighter">
                              inf — {currentWord.infinitive}
                            </p>
                          )}
                          {showTranslation && getExampleTranslation(currentWord) && (
                            <motion.p
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              className="text-indigo-400/60 text-xs italic"
                            >
                              ({getExampleTranslation(currentWord)})
                            </motion.p>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="w-full max-w-sm space-y-6">
                      <div
                        className={`p-6 border-2 border-dashed rounded-2xl text-center transition-all ${
                          showTranslation
                            ? 'border-indigo-200 bg-indigo-50/30'
                            : 'border-slate-200 bg-slate-50/50'
                        }`}
                      >
                        {showTranslation ? (
                          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                            <p className="text-xs text-indigo-400 uppercase font-bold tracking-widest mb-1">
                              {(currentWord?.review_count ?? 0) >= 2 ? 'En français' : 'Traduction'}
                            </p>
                            <p className="text-xl sm:text-2xl font-bold text-indigo-600">
                              {(currentWord?.review_count ?? 0) >= 2
                                ? getWordWithArticle(currentWord?.word || '', currentWord?.gender, currentWord?.isPlural)
                                : currentWord?.translation}
                            </p>
                            {currentWord?.infinitive && (
                              <motion.div
                                initial={{ opacity: 0, y: 5 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="mt-2 pt-2 border-t border-indigo-100/50"
                              >
                                <p className="text-[10px] text-indigo-400 uppercase font-bold tracking-widest mb-0.5">Infinitif</p>
                                <p className="text-sm font-medium text-indigo-500">
                                  {currentWord.infinitive}
                                  {currentWord.infinitiveTranslation && (
                                    <span className="text-indigo-400/70 font-normal italic ml-1.5">
                                      ({currentWord.infinitiveTranslation})
                                    </span>
                                  )}
                                </p>
                              </motion.div>
                            )}
                          </motion.div>
                        ) : (
                          <p className="text-slate-400 font-medium">
                            Rappelez-vous la réponse, puis répondez ci-dessous
                          </p>
                        )}
                      </div>

                      {/* Step 1 — commit BEFORE seeing the answer */}
                      {!showTranslation && (
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="space-y-3"
                        >
                          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 text-center">
                            {(currentWord?.review_count ?? 0) >= 2 ? 'Connaissez-vous le mot français ?' : 'Connaissez-vous la traduction ?'}
                          </p>
                          <div className="grid grid-cols-2 gap-3">
                            <button
                              onClick={() => { setCardCommit('unknown'); setShowTranslation(true); }}
                              className="flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-red-100 hover:bg-red-50 hover:border-red-300 transition-colors group"
                            >
                              <XCircle className="text-red-400 group-hover:text-red-500" size={26} />
                              <span className="text-[10px] font-bold uppercase text-red-500">Je ne sais pas</span>
                            </button>
                            <button
                              onClick={() => { setCardCommit('known'); setShowTranslation(true); }}
                              className="flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-emerald-100 hover:bg-emerald-50 hover:border-emerald-300 transition-colors group"
                            >
                              <CheckCircle2 className="text-emerald-400 group-hover:text-emerald-500" size={26} />
                              <span className="text-[10px] font-bold uppercase text-emerald-600">Je sais</span>
                            </button>
                          </div>
                        </motion.div>
                      )}

                      {/* Step 2 — verify the commitment against the revealed answer */}
                      {showTranslation && cardCommit === 'known' && (
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="space-y-3"
                        >
                          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 text-center">
                            Votre réponse était-elle juste ?
                          </p>
                          <div className="grid grid-cols-3 gap-3">
                            <button
                              onClick={() => handleReview('forgotten')}
                              className="flex flex-col items-center gap-2 p-3 rounded-xl border border-red-100 hover:bg-red-50 transition-colors group"
                            >
                              <XCircle className="text-red-400 group-hover:text-red-500" size={24} />
                              <span className="text-[10px] font-bold uppercase text-red-500">Non</span>
                            </button>
                            <button
                              onClick={() => handleReview('almost')}
                              className="flex flex-col items-center gap-2 p-3 rounded-xl border border-amber-100 hover:bg-amber-50 transition-colors group"
                            >
                              <AlertCircle className="text-amber-400 group-hover:text-amber-500" size={24} />
                              <span className="text-[10px] font-bold uppercase text-amber-600">Presque</span>
                            </button>
                            <button
                              onClick={() => handleReview('remembered')}
                              className="flex flex-col items-center gap-2 p-3 rounded-xl border border-emerald-100 hover:bg-emerald-50 transition-colors group"
                            >
                              <CheckCircle2 className="text-emerald-400 group-hover:text-emerald-500" size={24} />
                              <span className="text-[10px] font-bold uppercase text-emerald-600">Oui, exact</span>
                            </button>
                          </div>
                        </motion.div>
                      )}

                      {/* Committed "I don't know" — no self-grading needed, it's already an honest miss */}
                      {showTranslation && cardCommit === 'unknown' && (
                        <motion.button
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          onClick={() => handleReview('forgotten')}
                          className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-indigo-700 active:scale-[0.98] transition-all shadow-lg shadow-indigo-100 flex items-center justify-center gap-2"
                        >
                          <ChevronRight size={18} />
                          Mot suivant
                        </motion.button>
                      )}
                    </div>
                    
                    <div className="absolute top-4 right-4 flex items-center gap-2">
                      <button 
                        onClick={() => setEditingWord(currentWord)}
                        className="p-1 text-slate-300 hover:text-indigo-500 transition-colors"
                        title="Modifier ce mot"
                      >
                        <Edit2 size={18} />
                      </button>
                      <button 
                        onClick={() => {
                          if (currentWord) {
                            handleDeleteWord(currentWord.id);
                          }
                        }}
                        className="p-1 text-slate-300 hover:text-red-500 transition-colors"
                        title="Supprimer ce mot de la base"
                      >
                        <X size={20} />
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            </div>
          </section>

          {/* Left Section: Dictionary */}
          <section id="dictionary-section" className="order-1 lg:col-span-5 space-y-6 flex flex-col">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Search size={18} className="text-indigo-600" />
              Dictionnaire Intelligent
            </h2>

            <div className="bg-gradient-to-br from-indigo-50 via-white to-purple-50 border-2 border-indigo-200 rounded-3xl p-6 shadow-md shadow-indigo-100/50 space-y-6 flex-1 flex flex-col">
              <div className="space-y-3">
                <AnimatePresence>
                  {showAccents && (
                    <motion.div 
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="flex flex-wrap gap-1.5 pb-2">
                        {['é', 'à', 'è', 'ù', 'â', 'ê', 'î', 'ô', 'û', 'ë', 'ï', 'ü', 'ç', 'œ'].map(char => (
                          <button
                            key={char}
                            onClick={() => setSearchQuery(prev => prev + char)}
                            className="w-8 h-8 flex items-center justify-center bg-slate-50 border border-slate-200 rounded-lg text-sm font-bold text-slate-600 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600 transition-all"
                          >
                            {char}
                          </button>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
                
                <div className="relative">
                  <input
                    id="fr_word_input"
                    type="text"
                    placeholder={`Mot français ou ${currentLangObj.name.toLowerCase()}...`}
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setError(null);
                      setSuggestions([]);
                      lastFetchedQuery.current = '';
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && triggerSearch()}
                    className="w-full pl-12 pr-24 py-4 bg-white border-2 border-indigo-500 rounded-2xl shadow-lg shadow-indigo-300/50 focus:ring-4 focus:ring-indigo-300/60 focus:border-indigo-600 outline-none transition-all font-semibold text-base placeholder:text-slate-400 placeholder:font-normal"
                  />
                  <button
                    onClick={triggerSearch}
                    className="absolute left-4 top-1/2 -translate-y-1/2 text-indigo-500 hover:text-indigo-700 transition-colors"
                    title="Rechercher"
                  >
                    <Search size={20} />
                  </button>
                  
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    <button 
                      onClick={() => setShowAccents(!showAccents)}
                      className={`p-1.5 rounded-lg transition-colors ${showAccents ? 'bg-indigo-100 text-indigo-600' : 'text-slate-400 hover:bg-slate-100'}`}
                      title="Clavier d'accents"
                    >
                      <Keyboard size={18} />
                    </button>
                    
                    {searchQuery && !isSearching && (
                      <button 
                        onClick={() => setSearchQuery('')}
                        className="p-1.5 text-slate-300 hover:text-slate-500 transition-colors"
                      >
                        <X size={16} />
                      </button>
                    )}
                    
                    {isSearching && (
                      <div className="p-1.5 text-indigo-400">
                        <Loader2 className="animate-spin" size={18} />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <AnimatePresence mode="wait">
                {searchResult ? (
                  <motion.div 
                    key="result"
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    className="p-4 bg-indigo-50/50 rounded-2xl border border-indigo-100 space-y-3"
                  >
                    <div className="space-y-2">
                      <p className="text-[10px] font-bold uppercase text-indigo-400 tracking-widest leading-none">Français</p>
                      <h4 className="text-xl sm:text-2xl font-bold text-slate-900 break-words">
                        {getWordWithArticle(searchResult.word, searchResult.gender, searchResult.isPlural)}
                      </h4>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <button
                          onClick={() => speak(searchResult.word)}
                          className="p-1 px-1.5 bg-indigo-50 text-indigo-600 rounded-lg hover:bg-indigo-100 transition-colors"
                          title="Écouter"
                        >
                          <Volume2 size={16} />
                        </button>
                        {searchResult.gender && searchResult.gender !== 'none' && (
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                            searchResult.gender === 'm' ? 'bg-blue-100 text-blue-600' : 'bg-pink-100 text-pink-600'
                          }`}>
                            {searchResult.gender === 'm' ? 'm' : 'f'}
                          </span>
                        )}
                        {searchResult.infinitive && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-purple-100 text-purple-600">
                            v
                          </span>
                        )}
                        <button
                          onClick={() => {
                            setWordListSearchQuery(searchResult.word);
                            setIsWordListModalOpen(true);
                          }}
                          className="px-1.5 py-1 bg-white border border-indigo-100 rounded-lg text-[9px] font-bold text-indigo-600 uppercase hover:bg-indigo-50 transition-colors"
                        >
                          En base
                        </button>
                        <button
                          onClick={() => setEditingWord(searchResult)}
                          className="p-1.5 text-slate-300 hover:text-indigo-500 hover:bg-indigo-50 rounded-lg transition-all"
                          title="Modifier"
                        >
                          <Edit2 size={16} />
                        </button>
                        <button
                          onClick={(e) => handleDeleteWord(searchResult.id, e)}
                          className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                          title="Supprimer"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                    <div>
                        <p className="text-[10px] font-bold uppercase text-indigo-400 tracking-widest">{currentLangObj.name}</p>
                        <p className="text-lg font-semibold text-indigo-600">{searchResult.translation}</p>
                      {searchResult.infinitive && normalizeWord(searchResult.infinitive) !== normalizeWord(searchResult.word) && (
                        <p className="text-xs font-medium text-indigo-500 mt-1">
                          Infinitif: {searchResult.infinitive}
                          {searchResult.infinitiveTranslation && (
                            <span className="text-indigo-400/70 font-normal italic ml-1">
                              ({searchResult.infinitiveTranslation})
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                    {searchResult.example && (
                      <div>
                        <p className="text-[10px] font-bold uppercase text-indigo-400 tracking-widest">Exemple</p>
                        <p className="text-sm text-slate-600 italic leading-relaxed inline-flex items-start gap-1.5">
                          <span>{cleanExample(searchResult.example)}</span>
                          <button
                            onClick={() => speak(cleanExample(searchResult.example))}
                            className="p-0.5 text-indigo-300 hover:text-indigo-600 transition-colors shrink-0"
                            title="Écouter la phrase"
                          >
                            <Volume2 size={14} />
                          </button>
                        </p>
                        {getExampleTranslation(searchResult) && (
                          <p className="text-[10px] text-slate-400 italic mt-1">
                            ({getExampleTranslation(searchResult)})
                          </p>
                        )}
                      </div>
                    )}
                    {/* Collocations — learn the word in context. Tapping one saves the PHRASE to the base */}
                    <div className="pt-3 border-t border-indigo-100 space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] font-bold uppercase text-indigo-400 tracking-widest">
                          En contexte
                        </p>
                        <button
                          onClick={() => fetchCollocations(searchResult)}
                          disabled={isLoadingCollocations}
                          className="text-[9px] font-bold uppercase tracking-widest text-indigo-400 hover:text-indigo-600 transition-colors flex items-center gap-1 disabled:opacity-50"
                        >
                          {isLoadingCollocations
                            ? <><Loader2 size={11} className="animate-spin" /> Chargement</>
                            : <><Sparkles size={11} /> {collocationsFor === searchResult.word && collocations.length > 0 ? "Plus d'exemples" : 'Voir les expressions'}</>}
                        </button>
                      </div>

                      {collocationsFor === searchResult.word && collocations.length > 0 ? (
                        <>
                          <div className="space-y-1.5">
                            {collocations.map((c) => {
                              const saved = savedCollocations.has(normalizeWord(c.phrase))
                                || words.some(w => normalizeWord(w.word) === normalizeWord(c.phrase));
                              return (
                                <button
                                  key={c.phrase}
                                  onClick={() => !saved && saveCollocation(c, searchResult)}
                                  disabled={saved}
                                  className={`w-full text-left px-3 py-2 rounded-xl border transition-all ${
                                    saved
                                      ? 'bg-emerald-50 border-emerald-200 cursor-default'
                                      : 'bg-white border-indigo-100 hover:border-indigo-300 hover:bg-indigo-50/50 active:scale-[0.99]'
                                  }`}
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <p className={`text-sm font-bold break-words ${saved ? 'text-emerald-700' : 'text-slate-800'}`}>
                                        {c.phrase}
                                      </p>
                                      <p className="text-[11px] text-slate-500 break-words">{c.translation}</p>
                                    </div>
                                    {saved
                                      ? <CheckCircle2 size={16} className="text-emerald-500 shrink-0 mt-0.5" />
                                      : <Plus size={16} className="text-indigo-300 shrink-0 mt-0.5" />}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                          <p className="text-[9px] text-slate-400 leading-snug">
                            Touchez une expression pour l'ajouter à votre base — vous l'apprendrez en contexte.
                          </p>
                        </>
                      ) : !isLoadingCollocations && (
                        <p className="text-[10px] text-slate-400 leading-snug">
                          Chargez des expressions courantes avec ce mot pour l'apprendre en contexte.
                        </p>
                      )}
                    </div>

                    <div className="pt-2 flex items-center justify-between border-t border-indigo-100">
                      <span className={`text-[10px] uppercase font-bold tracking-tighter px-2 py-0.5 rounded ${
                        searchResult.status === 'mastered' ? 'bg-emerald-100 text-emerald-600' :
                        searchResult.status === 'learning' ? 'bg-amber-100 text-amber-600' : 'bg-slate-100 text-slate-500'
                      }`}>
                        {searchResult.status === 'mastered' ? 'Appris' :
                         searchResult.status === 'learning' ? 'En cours' : 'Nouveau'}
                      </span>
                      <span className="text-[10px] text-slate-400 uppercase font-bold tracking-tighter">
                        Révisions: {searchResult.review_count}
                      </span>
                    </div>

                    {suggestions.length > 0 && (
                      <div className="pt-3 border-t border-indigo-50 mt-1">
                        <p className="text-[9px] font-bold uppercase text-slate-400 mb-2">Mots similaires :</p>
                        <div className="flex flex-wrap gap-1.5">
                          {suggestions.map((s) => (
                            <button
                              key={s}
                              onClick={() => setSearchQuery(s)}
                              className="px-2 py-0.5 bg-slate-50 border border-slate-100 rounded-full text-[10px] font-medium text-slate-500 hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </motion.div>
                ) : isSearching ? (
                  <motion.div 
                    key="loading"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-center py-12 space-y-4"
                  >
                    <div className="relative inline-block">
                      <Sparkles className="text-indigo-500 animate-pulse" size={32} />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-700">Traduction automatique...</p>
                      <p className="text-xs text-slate-400 mt-1">L'IA prépare votre fiche de vocabulaire</p>
                    </div>
                  </motion.div>
                ) : error ? (
                  <motion.div 
                    key="error"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="p-4 bg-red-50 rounded-2xl border border-red-100 text-center space-y-2"
                  >
                    <AlertCircle className="mx-auto text-red-500" size={24} />
                    <p className="text-xs text-red-600 font-medium">{error}</p>
                    <button 
                      onClick={() => fetchTranslation(searchQuery)}
                      className="mt-2 px-4 py-1 bg-red-100 text-red-600 rounded-lg text-[10px] font-bold uppercase hover:bg-red-200 transition-colors"
                    >
                      Réessayer
                    </button>
                    {suggestions.length > 0 && (
                      <div className="flex flex-wrap justify-center gap-2 mt-3">
                        {suggestions.map((s) => (
                          <button
                            key={s}
                            onClick={() => setSearchQuery(s)}
                            className="px-3 py-1 bg-white border border-red-200 rounded-full text-xs font-bold text-red-600 hover:bg-red-100 transition-colors"
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </motion.div>
                ) : searchQuery ? (
                  <motion.div 
                    key="waiting"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-center py-12 space-y-3 opacity-40"
                  >
                    <Loader2 size={32} className="mx-auto text-slate-300 animate-spin" />
                    <p className="text-sm font-medium text-slate-500">Recherche en cours...</p>
                  </motion.div>
                ) : (
                  (() => {
                    const langWords = words.filter(w => targetLanguage === 'Russe'
                      ? (!w.target_lang || w.target_lang === 'Russe')
                      : w.target_lang === targetLanguage);
                    const forgotten = langWords.filter(w => w.last_grade === 'forgotten').length;
                    const almost = langWords.filter(w => w.last_grade === 'almost').length;
                    const remembered = langWords.filter(w => w.last_grade === 'remembered' || w.status === 'mastered').length;
                    const fresh = Math.max(0, langWords.length - forgotten - almost - remembered);
                    const total = Math.max(1, langWords.length);
                    return (
                      <motion.div key="stats" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex-1 flex flex-col pt-1">
                        {/* Hint centered in the free space */}
                        <div className="flex-1 flex items-center justify-center py-8">
                          <p className="text-sm text-indigo-400/80 font-medium text-center flex items-center justify-center gap-2 max-w-xs">
                            <Sparkles size={16} className="shrink-0" />
                            Découvrez la traduction — mot ou phrase, français ou {currentLangObj.name.toLowerCase()}
                          </p>
                        </div>

                        {/* Memory-state bar pinned to the bottom */}
                        <div className="p-4 bg-white/80 border border-indigo-100 rounded-2xl shadow-sm space-y-3">
                          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">État de la mémoire</p>
                          <div className="h-2.5 w-full rounded-full overflow-hidden flex">
                            {forgotten > 0 && <div className="h-full bg-red-400" style={{ width: `${(forgotten / total) * 100}%` }} />}
                            {almost > 0 && <div className="h-full bg-amber-400" style={{ width: `${(almost / total) * 100}%` }} />}
                            {remembered > 0 && <div className="h-full bg-emerald-400" style={{ width: `${(remembered / total) * 100}%` }} />}
                            {fresh > 0 && <div className="h-full bg-slate-200" style={{ width: `${(fresh / total) * 100}%` }} />}
                          </div>
                          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                            <span className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500">
                              <span className="w-2.5 h-2.5 bg-red-400 rounded-sm inline-block" /> Oublié {forgotten}
                            </span>
                            <span className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500">
                              <span className="w-2.5 h-2.5 bg-amber-400 rounded-sm inline-block" /> Presque {almost}
                            </span>
                            <span className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500">
                              <span className="w-2.5 h-2.5 bg-emerald-400 rounded-sm inline-block" /> Retenu {remembered}
                            </span>
                            <span className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500">
                              <span className="w-2.5 h-2.5 bg-slate-200 rounded-sm inline-block" /> Nouveau {fresh}
                            </span>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })()
                )}
              </AnimatePresence>
            </div>
          </section>
        </div>
      </main>

      {/* Edit Word Modal */}
      <AnimatePresence>
        {editingWord && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setEditingWord(null)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-lg bg-white rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-xl font-bold text-slate-900">Modifier le mot</h3>
                <button onClick={() => setEditingWord(null)} className="text-slate-400 hover:text-slate-600">
                  <X size={24} />
                </button>
              </div>
              
              <form onSubmit={handleSaveEdit} className="p-6 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest ml-1">Mot (Français)</label>
                    <input 
                      type="text"
                      value={editingWord.word}
                      onChange={(e) => setEditingWord({ ...editingWord, word: e.target.value })}
                      className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all text-sm font-medium"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest ml-1">Traduction ({currentLangObj.name})</label>
                    <input 
                      type="text"
                      value={editingWord.translation}
                      onChange={(e) => setEditingWord({ ...editingWord, translation: e.target.value })}
                      className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all text-sm font-medium"
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest ml-1">Genre</label>
                    <div className="flex gap-2">
                      {(['m', 'f', 'none'] as const).map((g) => (
                        <button
                          key={g}
                          type="button"
                          onClick={() => setEditingWord({ ...editingWord, gender: g })}
                          className={`flex-1 py-2 rounded-xl text-xs font-bold uppercase transition-all border ${
                            editingWord.gender === g 
                              ? 'bg-indigo-600 border-indigo-600 text-white shadow-md' 
                              : 'bg-white border-slate-200 text-slate-400 hover:border-indigo-200'
                          }`}
                        >
                          {g === 'none' ? 'Aucun' : g === 'm' ? 'Masc' : 'Fém'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest ml-1">Nombre</label>
                    <div className="flex gap-2">
                      {[false, true].map((p) => (
                        <button
                          key={String(p)}
                          type="button"
                          onClick={() => setEditingWord({ ...editingWord, isPlural: p })}
                          className={`flex-1 py-2 rounded-xl text-xs font-bold uppercase transition-all border ${
                            !!editingWord.isPlural === p 
                              ? 'bg-indigo-600 border-indigo-600 text-white shadow-md' 
                              : 'bg-white border-slate-200 text-slate-400 hover:border-indigo-200'
                          }`}
                        >
                          {p ? 'Pluriel' : 'Singulier'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest ml-1">Infinitif (Optionnel)</label>
                    <input 
                      type="text"
                      value={editingWord.infinitive || ''}
                      onChange={(e) => setEditingWord({ ...editingWord, infinitive: e.target.value })}
                      className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all text-sm font-medium"
                      placeholder="ex: manger"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest ml-1">Trad. Infinitif</label>
                    <input 
                      type="text"
                      value={editingWord.infinitiveTranslation || ''}
                      onChange={(e) => setEditingWord({ ...editingWord, infinitiveTranslation: e.target.value })}
                      className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all text-sm font-medium"
                      placeholder="ex: есть"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest ml-1">Exemple (Optionnel)</label>
                  <textarea 
                    value={editingWord.example || ''}
                    onChange={(e) => setEditingWord({ ...editingWord, example: e.target.value })}
                    className="w-full h-20 px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all text-sm font-medium resize-none"
                    placeholder="Une phrase d'exemple..."
                  />
                </div>

                <div className="flex gap-3 pt-4">
                  <button 
                    type="button"
                    onClick={() => setEditingWord(null)}
                    className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-bold hover:bg-slate-200 transition-all"
                  >
                    Annuler
                  </button>
                  <button 
                    type="submit"
                    className="flex-1 py-3 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200"
                  >
                    Enregistrer
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Upload Modal */}
      <AnimatePresence>
        {isUploadModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsUploadModalOpen(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-2xl bg-white rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-xl font-bold text-slate-900">Importer des mots</h3>
                <button onClick={() => setIsUploadModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                  <X size={24} />
                </button>
              </div>
              
              <div className="p-8 grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Variant A: Text Input */}
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-indigo-600">
                    <FileText size={20} />
                    <h4 className="font-bold">Copier-coller</h4>
                  </div>
                  <p className="text-xs text-slate-500">Insérez votre список (ex: mot - traduction)</p>
                  <textarea 
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                    className="w-full h-48 p-4 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all resize-none text-sm font-mono"
                    placeholder="laisser - оставлять&#10;manger - есть"
                  />
                  <button 
                    onClick={handleBulkAdd}
                    disabled={!bulkText.trim() || isUploading}
                    className="w-full py-3 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {isUploading ? (
                      <>
                        <Loader2 className="animate-spin" size={18} />
                        Analyse...
                      </>
                    ) : (
                      "Ajouter la liste"
                    )}
                  </button>
                </div>

                {/* Variant B: Document Upload */}
                <div className="space-y-4 border-l border-slate-100 pl-0 md:pl-8">
                  <div className="flex items-center gap-2 text-emerald-600">
                    <Upload size={20} />
                    <h4 className="font-bold">Documents & Tableaux</h4>
                  </div>
                  <p className="text-xs text-slate-500">Word, Excel, PDF, CSV ou TXT</p>
                  <div className="h-48 border-2 border-dashed border-slate-200 rounded-xl flex flex-col items-center justify-center p-6 text-center space-y-4 bg-slate-50/50 relative group hover:border-emerald-300 transition-all">
                    {isUploading ? (
                      <div className="flex flex-col items-center gap-3">
                        <Loader2 className="text-emerald-500 animate-spin" size={32} />
                        <p className="text-xs font-bold text-slate-600 uppercase">Analyse IA en cours...</p>
                      </div>
                    ) : (
                      <>
                        <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center text-slate-300 shadow-sm group-hover:text-emerald-500 transition-all">
                          <Upload size={24} />
                        </div>
                        <div>
                          <p className="text-sm font-bold text-slate-700">Déposer ou cliquer</p>
                          <p className="text-[10px] text-slate-400 uppercase font-bold mt-1">L'IA reconnaîtra les mots</p>
                        </div>
                        <input 
                          type="file" 
                          accept=".csv,.txt,.xlsx,.xls,.docx,.pdf" 
                          onChange={handleFileUpload}
                          className="absolute inset-0 opacity-0 cursor-pointer"
                        />
                      </>
                    )}
                  </div>
                  <div className="pt-4">
                    <p className="text-[10px] text-slate-400 italic">
                      * L'IA extraira automatiquement les mots, traductions et род.
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {/* Installation Guide Modal */}
        {isInstallModalOpen && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-3xl shadow-2xl max-w-md w-full overflow-hidden"
            >
              <div className="p-8">
                <div className="flex justify-between items-start mb-6">
                  <div>
                    <h3 className="text-xl font-bold text-slate-900">{currentGuide.title}</h3>
                    <p className="text-sm text-slate-500 mt-1">{currentGuide.subtitle}</p>
                  </div>
                  <button onClick={() => setIsInstallModalOpen(false)} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
                    <X size={20} className="text-slate-400" />
                  </button>
                </div>

                <div className="space-y-6">
                  <div className="flex gap-4">
                    <div className="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center shrink-0">
                      <span className="text-indigo-600 font-bold">A</span>
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-800">{currentGuide.androidTitle}</p>
                      <p className="text-xs text-slate-500 mt-1">{currentGuide.androidDesc}</p>
                    </div>
                  </div>

                  <div className="flex gap-4">
                    <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center shrink-0">
                      <span className="text-emerald-600 font-bold">i</span>
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-800">{currentGuide.iosTitle}</p>
                      <p className="text-xs text-slate-500 mt-1">{currentGuide.iosDesc}</p>
                    </div>
                  </div>

                  <div className="flex gap-4">
                    <div className="w-10 h-10 bg-slate-50 rounded-xl flex items-center justify-center shrink-0">
                      <span className="text-slate-600 font-bold">M</span>
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-800">{currentGuide.desktopTitle}</p>
                      <p className="text-xs text-slate-500 mt-1">{currentGuide.desktopDesc}</p>
                    </div>
                  </div>
                </div>

                <button 
                  onClick={() => setIsInstallModalOpen(false)}
                  className="w-full mt-8 py-4 bg-indigo-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100"
                >
                  {currentGuide.button}
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {/* Word List Modal */}
        {isWordListModalOpen && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 md:p-6">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-white sticky top-0 z-10">
                <div>
                  <h3 className="text-xl font-bold text-slate-900">Ma Bibliothèque</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {words.filter(w => targetLanguage === 'Russe' ? (!w.target_lang || w.target_lang === 'Russe') : (w.target_lang === targetLanguage)).length} / {words.length} mots ({currentLangObj.name})
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {words.length > 0 && (
                    <button
                      onClick={() => {
                        const esc = (s: string) => `"${(s || '').replace(/"/g, '""')}"`;
                        const header = 'word;translation;gender;example;exampleTranslation;status;review_count';
                        const rows = words.map(w =>
                          [w.word, w.translation, w.gender || '', w.example || '', w.exampleTranslation || '', w.status, String(w.review_count ?? 0)].map(esc).join(';')
                        );
                        const csv = '﻿' + [header, ...rows].join('\r\n');
                        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = `francabulaire_${dayKey(new Date())}.csv`;
                        a.click();
                        URL.revokeObjectURL(a.href);
                      }}
                      className="flex items-center gap-2 px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-xl text-[10px] font-bold uppercase tracking-widest hover:bg-emerald-100 transition-colors"
                      title="Exporter en CSV"
                    >
                      <Download size={14} />
                      CSV
                    </button>
                  )}
                  {words.some(w => w.target_lang !== targetLanguage && !(targetLanguage === 'Russe' && !w.target_lang)) && (
                    <button
                      onClick={() => translateLibrary(targetLanguage)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-indigo-50 text-indigo-600 rounded-xl text-[10px] font-bold uppercase tracking-widest hover:bg-indigo-100 transition-colors"
                      title="Traduire les mots restants"
                    >
                      <RefreshCw size={14} className={isTranslatingLibrary ? "animate-spin" : ""} />
                      Traduire tout
                    </button>
                  )}
                  <button 
                    onClick={() => {
                      setIsWordListModalOpen(false);
                      setWordListSearchQuery('');
                    }} 
                    className="p-2 hover:bg-slate-100 rounded-full transition-colors"
                  >
                    <X size={20} className="text-slate-400" />
                  </button>
                </div>
              </div>

              <div className="p-4 bg-slate-50 border-b border-slate-100">
                <div className="relative">
                  <input 
                    type="text"
                    placeholder="Rechercher un mot..."
                    value={wordListSearchQuery}
                    onChange={(e) => setWordListSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all text-sm"
                  />
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {words
                  .filter(w => {
                    const matchesSearch = w.word.toLowerCase().includes(wordListSearchQuery.toLowerCase()) || 
                                        w.translation.toLowerCase().includes(wordListSearchQuery.toLowerCase());
                    const matchesLang = targetLanguage === 'Russe' 
                                      ? (!w.target_lang || w.target_lang === 'Russe')
                                      : (w.target_lang === targetLanguage);
                    return matchesSearch && matchesLang;
                  })
                  .sort((a, b) => b.created_at - a.created_at)
                  .map((w) => (
                    <div 
                      key={w.id}
                      className="group flex items-start sm:items-center justify-between p-3 gap-3 bg-white border border-slate-100 rounded-2xl hover:border-indigo-200 hover:shadow-sm transition-all"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          {w.target_lang && (
                            <span className="text-[10px] grayscale opacity-50 shrink-0">
                              {languages.find(l => l.id === w.target_lang)?.flag}
                            </span>
                          )}
                          <span className="font-bold text-slate-900 truncate">
                            {getWordWithArticle(w.word, w.gender, w.isPlural)}
                          </span>
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              speak(w.word);
                            }}
                            className="p-1 text-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-all shrink-0"
                            title="Écouter"
                          >
                            <Volume2 size={14} />
                          </button>
                          <div className="flex flex-wrap items-center gap-1">
                            {w.gender && w.gender !== 'none' && (
                              <span className={`px-1 py-0.5 rounded-[4px] text-[8px] font-bold uppercase shrink-0 ${
                                w.gender === 'm' ? 'bg-blue-50 text-blue-500' : 'bg-pink-50 text-pink-500'
                              }`}>
                                {w.gender === 'm' ? 'm' : 'f'}
                              </span>
                            )}
                            <span className={`text-[8px] font-bold uppercase px-1.5 py-0.5 rounded-full shrink-0 ${
                              w.status === 'mastered' ? 'bg-emerald-50 text-emerald-600' : 
                              w.status === 'learning' ? 'bg-amber-50 text-amber-600' : 'bg-slate-50 text-slate-400'
                            }`}>
                              {w.status === 'mastered' ? 'Appris' : w.status === 'learning' ? 'En cours' : 'Nouveau'}
                            </span>
                          </div>
                        </div>
                        <p className="text-xs text-indigo-600 font-medium truncate mt-0.5">
                          {w.translation}
                          {w.infinitive && (
                            <span className="text-indigo-400/70 font-normal italic ml-2">
                              (Inf: {w.infinitive}{w.infinitiveTranslation ? ` — ${w.infinitiveTranslation}` : ''})
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button 
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setEditingWord(w);
                          }}
                          className="p-2 text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 rounded-lg transition-all border border-transparent hover:border-indigo-100"
                          title="Modifier"
                        >
                          <Edit2 size={16} />
                        </button>
                        <button 
                          onClick={(e) => handleDeleteWord(w.id, e)}
                          className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all border border-transparent hover:border-red-100"
                          title="Supprimer"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                
                {words.length > 0 && words.filter(w => {
                  const matchesSearch = w.word.toLowerCase().includes(wordListSearchQuery.toLowerCase()) || 
                                      w.translation.toLowerCase().includes(wordListSearchQuery.toLowerCase());
                  const matchesLang = targetLanguage === 'Russe' 
                                    ? (!w.target_lang || w.target_lang === 'Russe')
                                    : (w.target_lang === targetLanguage);
                  return matchesSearch && matchesLang;
                }).length === 0 && (
                  <div className="text-center py-12 px-6">
                    <Languages size={40} className="mx-auto text-slate-200 mb-4" />
                    <p className="text-sm font-medium text-slate-900">Aucun mot en {currentLangObj.name}</p>
                    <p className="text-xs text-slate-500 mt-1 mb-6">
                      Vous avez {words.length} mots enregistrés, mais ils sont dans d'autres langues.
                    </p>
                    <button 
                      onClick={() => translateLibrary(targetLanguage)}
                      className="px-6 py-3 bg-indigo-600 text-white rounded-2xl font-bold text-xs uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 inline-flex items-center gap-2"
                    >
                      <RefreshCw size={16} />
                      Traduire tout en {currentLangObj.name}
                    </button>
                  </div>
                )}

                {words.length === 0 && (
                  <div className="text-center py-12">
                    <BookOpen size={48} className="mx-auto text-slate-200 mb-4" />
                    <p className="text-slate-400 font-medium">Votre bibliothèque est vide.</p>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}

        {/* Delete Confirmation Modal */}
        {deletingId && wordToDelete && (
          <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-[200] flex items-center justify-center p-6">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-3xl shadow-2xl max-w-sm w-full p-8 text-center"
            >
              <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto mb-4">
                <Trash2 size={32} />
              </div>
              <h3 className="text-xl font-bold text-slate-900">Supprimer le mot ?</h3>
              <p className="text-sm text-slate-500 mt-2">
                Voulez-vous vraiment supprimer <span className="font-bold text-slate-700">"{wordToDelete.word}"</span> ?
              </p>
              <div className="grid grid-cols-2 gap-3 mt-8">
                <button 
                  onClick={() => setDeletingId(null)}
                  className="py-3 bg-slate-100 text-slate-600 rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-slate-200 transition-all"
                >
                  Annuler
                </button>
                <button 
                  onClick={() => {
                    const idToRemove = deletingId;
                    setWords(prev => prev.filter(w => w.id !== idToRemove));
                    setDeletingId(null);

                    // Remove from exercise buckets too (they hold copies)
                    setExerciseBuckets(prev => ({
                      forgotten: prev.forgotten.filter(w => w.id !== idToRemove),
                      almost: prev.almost.filter(w => w.id !== idToRemove),
                      remembered: prev.remembered.filter(w => w.id !== idToRemove),
                    }));
                    setCurrentExerciseBatch(prev => prev.filter(w => w.id !== idToRemove));

                    if (searchResult && searchResult.id === idToRemove) {
                      setSearchQuery('');
                    }

                    // Remove the word from the active review session too
                    if (isReviewing) {
                      const idx = sessionQueue.findIndex(w => w.id === idToRemove);
                      if (idx !== -1) {
                        const next = sessionQueue.filter(w => w.id !== idToRemove);
                        if (next.length === 0) {
                          stopReview();
                        } else {
                          setSessionQueue(next);
                          setCurrentReviewIndex(ci => Math.min(idx < ci ? ci - 1 : ci, next.length - 1));
                          setShowTranslation(false);
                          setCardCommit(null);
                        }
                      }
                    }
                  }}
                  className="py-3 bg-red-500 text-white rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-red-600 transition-all shadow-lg shadow-red-100"
                >
                  Supprimer
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {/* Text Exercise Modal */}
        {isTextExerciseModalOpen && (
          <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-[200] flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-3xl shadow-2xl w-[95%] md:w-[80%] max-w-5xl max-h-[90vh] flex flex-col overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white z-10">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
                    <FileText size={24} />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-slate-900">Phrases à compléter</h3>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                      {(() => {
                        const total = exerciseBuckets.forgotten.length + exerciseBuckets.almost.length + exerciseBuckets.remembered.length + currentExerciseBatch.length;
                        return total > 0 ? `${total} mots restants` : 'Devinez le mot manquant dans chaque phrase';
                      })()}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => { setIsTextExerciseModalOpen(false); cancelCombo(); }}
                  className="p-2 hover:bg-slate-100 rounded-full text-slate-400 transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {!generatedStory && !isStoryLoading && (
                  <div className="text-center py-12 space-y-6">
                    <div className="w-20 h-20 bg-indigo-50 text-indigo-200 rounded-full flex items-center justify-center mx-auto">
                      <Sparkles size={40} />
                    </div>
                    <div className="space-y-2">
                      <h4 className="text-lg font-bold text-slate-900">Prêt pour un défi ?</h4>
                      <p className="text-sm text-slate-500 max-w-xs mx-auto">
                        Je vais créer des phrases indépendantes avec vos mots. À vous de trouver le mot manquant dans chaque phrase !
                      </p>
                    </div>
                    <button 
                      onClick={() => generateStoryExercise()}
                      className="px-8 py-4 bg-indigo-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 flex items-center gap-2 mx-auto"
                    >
                      <Sparkles size={18} />
                      Générer les phrases
                    </button>
                  </div>
                )}

                {isStoryLoading && (
                  <div className="text-center py-20">
                    <div className="relative w-16 h-16 mx-auto mb-6">
                      <div className="absolute inset-0 border-4 border-indigo-100 rounded-full"></div>
                      <div className="absolute inset-0 border-4 border-indigo-600 rounded-full border-t-transparent animate-spin"></div>
                    </div>
                    <p className="text-slate-500 font-medium animate-pulse">Création des phrases en cours...</p>
                  </div>
                )}

                {generatedStory && !isStoryLoading && (
                  <div className="space-y-6">
                    <div className="text-center">
                      <h4 className="text-xl font-serif font-bold text-slate-900 mb-2 italic">
                        {generatedStory.title}
                      </h4>
                      <div className="h-1 w-12 bg-indigo-100 mx-auto rounded-full"></div>
                    </div>

                    <div className="space-y-3">
                      {generatedStory.story.split('\n').filter(line => line.trim()).map((line, lineIndex) => (
                        <div key={lineIndex} className="flex items-start gap-3 p-4 bg-slate-50 rounded-2xl">
                          <span className="flex-shrink-0 w-6 h-6 bg-indigo-100 text-indigo-500 rounded-full text-xs font-bold flex items-center justify-center mt-0.5">{lineIndex + 1}</span>
                          <div className="text-base leading-relaxed text-slate-700 font-medium flex-1 flex flex-wrap items-center gap-y-1">
                            {line.split(/(\{\{\d+\}\})/).map((part, partIndex) => {
                              const match = part.match(/\{\{(\d+)\}\}/);
                              if (match) {
                                const gapIndex = parseInt(match[1]);
                                return (
                                  <button
                                    key={partIndex}
                                    onClick={() => {
                                      if (exerciseFeedback === 'success') return;
                                      if (userAnswers[gapIndex]) {
                                        const newAnswers = [...userAnswers];
                                        newAnswers[gapIndex] = '';
                                        setUserAnswers(newAnswers);
                                        setExerciseFeedback(null);
                                        setSelectedGapIndex(gapIndex);
                                      } else {
                                        setSelectedGapIndex(gapIndex === selectedGapIndex ? null : gapIndex);
                                      }
                                    }}
                                    className={`mx-1 px-3 py-1 rounded-lg border-2 transition-all inline-flex items-center justify-center min-w-[80px] h-9 cursor-pointer group hover:scale-105 active:scale-95 ${
                                      exerciseFeedback === 'success'
                                        ? 'bg-emerald-50 border-emerald-200 text-emerald-700 font-bold pointer-events-none'
                                        : exerciseFeedback === 'error' && userAnswers[gapIndex] !== generatedStory.gaps[gapIndex]
                                          ? 'bg-red-50 border-red-200 text-red-600 font-bold'
                                          : exerciseFeedback === 'error' && userAnswers[gapIndex] === generatedStory.gaps[gapIndex]
                                            ? 'bg-emerald-50 border-emerald-200 text-emerald-700 font-bold'
                                            : userAnswers[gapIndex]
                                              ? 'bg-indigo-50 border-indigo-200 text-indigo-700 font-bold'
                                              : 'bg-white border-dashed border-slate-300'
                                    } ${selectedGapIndex === gapIndex && !exerciseFeedback ? 'ring-2 ring-indigo-500 ring-offset-2 border-indigo-500' : ''}`}
                                  >
                                    {userAnswers[gapIndex] || (
                                      exerciseFeedback === 'error'
                                        ? <span className="text-red-400 text-xs font-bold">— пропущено —</span>
                                        : <span className="text-slate-300 text-xs font-bold opacity-0 group-hover:opacity-100 transition-opacity">?</span>
                                    )}
                                  </button>
                                );
                              }
                              return <span key={partIndex}>{part}</span>;
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Sticky bottom panel — word bank + verify button */}
              {generatedStory && !isStoryLoading && (
                <div className="border-t border-slate-100 bg-white p-4 space-y-3 flex-shrink-0">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Banque de mots</span>
                    <button
                      onClick={() => { setUserAnswers(new Array(generatedStory.gaps.length).fill('')); setExerciseFeedback(null); }}
                      className="text-[10px] font-bold uppercase text-slate-400 hover:text-red-500 transition-colors"
                    >
                      Effacer tout
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {generatedStory.shuffledGaps.map((word, index) => {
                      const usedCount = userAnswers.filter(a => a === word).length;
                      const totalCount = generatedStory.gaps.filter(g => g === word).length;
                      const isUsed = usedCount >= totalCount;
                      const isShowingHint = wordHintIndex === index;
                      const wordObj = words.find(w =>
                        w.word.toLowerCase() === word.toLowerCase() ||
                        (w.french_word && w.french_word.toLowerCase() === word.toLowerCase())
                      );
                      return (
                        <div key={index} className="relative group">
                          <button
                            disabled={isUsed || exerciseFeedback === 'success'}
                            onClick={() => {
                              if (isShowingHint) { setWordHintIndex(null); return; }
                              const newAnswers = [...userAnswers];
                              const targetIndex = selectedGapIndex !== null && userAnswers[selectedGapIndex] === ''
                                ? selectedGapIndex
                                : userAnswers.indexOf('');
                              if (targetIndex !== -1) {
                                newAnswers[targetIndex] = word;
                                setUserAnswers(newAnswers);
                                setExerciseFeedback(null);
                                if (targetIndex === selectedGapIndex) setSelectedGapIndex(null);
                              }
                            }}
                            className={`px-4 py-2 rounded-xl text-sm font-bold border transition-all min-h-[40px] flex items-center justify-center ${
                              isUsed
                                ? 'bg-slate-100 border-slate-100 text-slate-300 cursor-not-allowed opacity-50'
                                : 'bg-white border-slate-200 text-slate-700 hover:border-indigo-300 hover:bg-indigo-50 active:scale-95'
                            } ${isShowingHint ? 'bg-indigo-50 border-indigo-400 text-indigo-600 scale-[1.02] z-10 shadow-lg ring-2 ring-indigo-200' : ''}`}
                          >
                            {isShowingHint && wordObj ? wordObj.translation : word}
                          </button>
                          {!isUsed && exerciseFeedback !== 'success' && (
                            <button
                              onClick={(e) => { e.stopPropagation(); setWordHintIndex(isShowingHint ? null : index); }}
                              className={`absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center shadow-sm border transition-all z-20 ${
                                isShowingHint
                                  ? 'bg-indigo-600 border-indigo-600 text-white animate-pulse'
                                  : 'bg-white border-slate-200 text-slate-400 hover:text-indigo-600 hover:border-indigo-300'
                              }`}
                              title="Voir la traduction"
                            >
                              <Languages size={10} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={() => generateStoryExercise()}
                      className="p-3 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all flex-shrink-0"
                      title="Nouvelles phrases"
                    >
                      <RefreshCw size={20} />
                    </button>

                    <AnimatePresence mode="wait">
                      {exerciseFeedback === 'success' ? (
                        <motion.button
                          key="new"
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          onClick={() => generateStoryExercise()}
                          className="flex-1 py-3.5 bg-indigo-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-indigo-700 active:scale-[0.98] transition-all shadow-lg shadow-indigo-100 flex items-center justify-center gap-2"
                        >
                          <Sparkles size={16} />
                          Nouvelles phrases
                        </motion.button>
                      ) : (
                        <motion.button
                          key="verify"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          onClick={() => {
                            const isCorrect = userAnswers.every((ans, i) => ans === generatedStory.gaps[i]);
                            setExerciseFeedback(isCorrect ? 'success' : 'error');

                            // Match batch words to gaps tolerantly (AI may add articles or change case)
                            const matchWord = (gap: string) => currentExerciseBatch.find(w => {
                              const a = normalizeWord(stripArticles(w.word));
                              const b = normalizeWord(stripArticles(gap));
                              return a === b || a.includes(b) || b.includes(a);
                            });

                            // Remember words actually answered wrong (empty gap = not attempted, not an error)
                            generatedStory.gaps.forEach((gap, i) => {
                              if (userAnswers[i] && userAnswers[i] !== gap) {
                                const w = matchWord(gap);
                                if (w) batchWrongWordIds.current.add(w.id);
                              }
                            });

                            // Resolve each word once the whole batch is solved
                            if (isCorrect) {
                              currentExerciseBatch.forEach(w => {
                                const tier = currentExerciseBatchTiers.current[w.id] || 'almost';
                                resolveExerciseAnswer(w, tier, !batchWrongWordIds.current.has(w.id));
                              });
                              const textTotal = currentExerciseBatch.length;
                              const textCorrect = textTotal - batchWrongWordIds.current.size;
                              batchWrongWordIds.current.clear();
                              setCurrentExerciseBatch([]);
                              currentExerciseBatchTiers.current = {};
                              recordExerciseActivity(generatedStory.gaps.length);

                              if (comboMode === 'text') {
                                setComboResults(prev => ({ ...prev, text: { correct: textCorrect, total: textTotal } }));
                                setIsTextExerciseModalOpen(false);
                                setComboMode('compose');
                                startComposeActivity(COMPOSE_COMBO_SESSION_SIZE);
                              }
                            }
                          }}
                          className="flex-1 py-3.5 bg-indigo-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-indigo-700 active:scale-[0.98] transition-all shadow-lg shadow-indigo-100"
                        >
                          Vérifier
                        </motion.button>
                      )}
                    </AnimatePresence>
                  </div>

                  {exerciseFeedback === 'error' && (
                    <p className="text-center text-xs font-bold text-red-500 flex items-center justify-center gap-1.5">
                      <AlertCircle size={14} />
                      Certains mots ne sont pas à la bonne place.
                    </p>
                  )}
                  {exerciseFeedback === 'success' && (
                    <p className="text-center text-xs font-bold text-emerald-500 flex items-center justify-center gap-1.5">
                      <CheckCircle2 size={14} />
                      Parfait ! Toutes les réponses sont correctes.
                    </p>
                  )}
                </div>
              )}
            </motion.div>
          </div>
        )}

        {isMatchModalOpen && (
          <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-[200] flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-3xl shadow-2xl w-[95%] max-w-2xl flex flex-col overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white z-10">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
                    <Grid2X2 size={24} />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-slate-900">Relier les mots</h3>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Associez les mots et leurs traductions</p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    // Mid-game close: already-matched words were resolved live; return the rest to their tier buckets
                    if (matchPool.length > 0 && matchedIds.size < matchPool.length) {
                      const unmatched = matchPool.filter(w => !matchedIds.has(w.id));
                      setExerciseBuckets(prev => {
                        const next: ExBuckets = { forgotten: [...prev.forgotten], almost: [...prev.almost], remembered: [...prev.remembered] };
                        [...unmatched].reverse().forEach(w => {
                          const tier = matchPoolTiers.current[w.id] || 'almost';
                          next[tier] = [w, ...next[tier]];
                        });
                        return next;
                      });
                    }
                    matchWrongWordIds.current.clear();
                    setMatchPool([]);
                    setIsMatchModalOpen(false);
                    cancelCombo();
                  }}
                  className="p-2 hover:bg-slate-100 rounded-full text-slate-400 transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="p-6 flex flex-col gap-8">
                <div className="flex items-center justify-between px-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Progression</span>
                    <div className="h-2 w-32 bg-slate-100 rounded-full overflow-hidden">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: `${(matchedIds.size / matchPool.length) * 100}%` }}
                        className="h-full bg-indigo-500"
                      />
                    </div>
                    <span className="text-xs font-bold text-indigo-600">{matchedIds.size}/{matchPool.length}</span>
                  </div>
                  {matchedIds.size === matchPool.length && matchPool.length > 0 && (
                    <motion.span 
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="text-xs font-bold text-emerald-500 bg-emerald-50 px-3 py-1 rounded-full uppercase tracking-widest"
                    >
                      Terminé !
                    </motion.span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3 sm:gap-6 min-h-[400px]">
                  {/* Words Column */}
                  <div className="space-y-3">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 px-2 text-center">Français</p>
                    <AnimatePresence mode="popLayout" initial={false}>
                      {currentMatchWords.map((w) => {
                        const isMatched = matchedIds.has(w.id);
                        const isSelected = selectedWordId === w.id;
                        const isWrong = wrongMatch?.wordId === w.id;
                        const isCorrect = successfullyMatched === w.id;
                        
                        return !isMatched && (
                          <motion.button
                            key={`word-${w.id}`}
                            layout
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.9 }}
                            transition={{ 
                              opacity: { duration: 0.8 },
                              layout: { type: "spring", stiffness: 150, damping: 25 }
                            }}
                            disabled={isProcessingMatch}
                            onClick={() => {
                              if (isProcessingMatch) return;
                              setSelectedWordId(isSelected ? null : w.id);
                            }}
                            className={`w-full p-2.5 sm:p-4 rounded-2xl border-[3px] sm:border-4 text-[10px] sm:text-sm font-bold transition-all text-left min-h-[60px] sm:min-h-[70px] flex items-center justify-center text-center shadow-md relative ${
                              isCorrect ? 'bg-emerald-50 border-emerald-500 text-emerald-700 ring-8 ring-emerald-500/20 scale-[1.05] z-10' :
                              isWrong ? 'bg-red-50 border-red-500 text-red-700 animate-shake ring-8 ring-red-500/20 z-10' :
                              isSelected ? 'bg-indigo-50 border-indigo-500 text-indigo-700 ring-4 ring-indigo-100' :
                              'bg-white border-slate-100 text-slate-700 hover:border-indigo-200 hover:bg-slate-50'
                            }`}
                          >
                            <span className="break-words line-clamp-3 leading-tight">{getWordWithArticle(w.word, w.gender, w.isPlural)}</span>
                          </motion.button>
                        );
                      })}
                    </AnimatePresence>
                  </div>

                  {/* Translations Column */}
                  <div className="space-y-3">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 px-2 text-center">{currentLangObj.name}</p>
                    <AnimatePresence mode="popLayout" initial={false}>
                      {shuffledTranslations.map((t) => {
                        const isMatched = matchedIds.has(t.id);
                        const isSelected = selectedTranslationId === t.id;
                        const isWrong = wrongMatch?.transId === t.id;
                        const isCorrect = successfullyMatched === t.id;
                        
                        return !isMatched && (
                          <motion.button
                            key={`trans-${t.id}`}
                            layout
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.9 }}
                            transition={{ 
                              opacity: { duration: 0.8 },
                              layout: { type: "spring", stiffness: 150, damping: 25 }
                            }}
                            disabled={isProcessingMatch}
                            onClick={() => {
                              if (isProcessingMatch) return;
                              setSelectedTranslationId(isSelected ? null : t.id);
                            }}
                            className={`w-full p-2.5 sm:p-4 rounded-2xl border-[3px] sm:border-4 text-[10px] sm:text-sm font-bold transition-all text-left min-h-[60px] sm:min-h-[70px] flex items-center justify-center text-center shadow-md relative ${
                              isCorrect ? 'bg-emerald-50 border-emerald-500 text-emerald-700 ring-8 ring-emerald-500/20 scale-[1.05] z-10' :
                              isWrong ? 'bg-red-50 border-red-500 text-red-700 animate-shake ring-8 ring-red-500/20 z-10' :
                              isSelected ? 'bg-indigo-50 border-indigo-500 text-indigo-700 ring-4 ring-indigo-100' :
                              'bg-white border-slate-100 text-slate-700 hover:border-indigo-200 hover:bg-slate-50'
                            }`}
                          >
                            <span className="break-words line-clamp-3 leading-tight">{t.text}</span>
                          </motion.button>
                        );
                      })}
                    </AnimatePresence>
                  </div>
                </div>

                {matchedIds.size === matchPool.length && matchPool.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-center pt-4 space-y-3"
                  >
                    <p className="text-2xl font-black text-slate-900">
                      {Math.round(((matchPool.length - matchWrongWordIds.current.size) / matchPool.length) * 100)}%
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-widest ml-2">du premier coup</span>
                    </p>
                    {comboMode === 'match' ? (
                      <button
                        onClick={() => {
                          setComboResults(prev => ({ ...prev, match: { correct: matchPool.length - matchWrongWordIds.current.size, total: matchPool.length } }));
                          setMatchPool([]);
                          setIsMatchModalOpen(false);
                          setComboMode('quiz');
                          startQuizGame();
                        }}
                        className="px-8 py-4 bg-indigo-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 flex items-center gap-2 mx-auto"
                      >
                        <CheckCircle2 size={18} />
                        Continuer : Quiz
                      </button>
                    ) : (
                      <button
                        onClick={startMatchGame}
                        className="px-8 py-4 bg-emerald-500 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-emerald-600 transition-all shadow-lg shadow-emerald-100 flex items-center gap-2 mx-auto"
                      >
                        <RotateCcw size={18} />
                        Rejouer
                      </button>
                    )}
                  </motion.div>
                )}
              </div>
            </motion.div>
          </div>
        )}

        {/* Reverse Practice Modal: translation → French */}
        {isReverseModalOpen && (
          <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-[200] flex items-center justify-center p-4 sm:p-6">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-3xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-purple-50 text-purple-600 rounded-xl">
                    <Languages size={24} />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-slate-900">Rappel actif</h3>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                      {reverseSessionOver ? 'Session terminée' : `${currentLangObj.flag} → 🇫🇷 · Mot ${reverseSession.done + 1} sur ${reverseLimit}`}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (reverseWord && reverseTier) {
                      setExerciseBuckets(prev => ({ ...prev, [reverseTier]: [reverseWord, ...prev[reverseTier]] }));
                    }
                    setIsReverseModalOpen(false);
                    setReverseWord(null);
                    setReverseTier(null);
                    cancelCombo();
                  }}
                  className="p-2 hover:bg-slate-100 rounded-full text-slate-400 transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              {reverseSessionOver ? (
                <div className="p-8 flex flex-col items-center gap-6 text-center">
                  <div className="w-16 h-16 bg-purple-50 text-purple-500 rounded-full flex items-center justify-center">
                    <CheckCircle2 size={32} />
                  </div>
                  <div>
                    <p className="text-3xl font-black text-slate-900">{Math.round((reverseSession.correct / Math.max(1, reverseSession.done)) * 100)}%</p>
                    <p className="text-sm text-slate-500 mt-1">{reverseSession.correct} / {reverseSession.done} mots retrouvés</p>
                  </div>
                  {comboMode === 'reverse' ? (
                    <button
                      onClick={() => {
                        setComboResults(prev => ({ ...prev, reverse: { correct: reverseSession.correct, total: reverseSession.done } }));
                        setIsReverseModalOpen(false);
                        setComboMode('match');
                        startMatchGame();
                      }}
                      className="w-full py-3.5 bg-indigo-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-indigo-700 active:scale-[0.98] transition-all shadow-lg shadow-indigo-100 flex items-center justify-center gap-2"
                    >
                      <Grid2X2 size={16} />
                      Continuer : Relier les mots
                    </button>
                  ) : (
                    <button
                      onClick={startReversePractice}
                      className="w-full py-3.5 bg-purple-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-purple-700 active:scale-[0.98] transition-all shadow-lg shadow-purple-100 flex items-center justify-center gap-2"
                    >
                      <Sparkles size={16} />
                      Nouvelle session
                    </button>
                  )}
                </div>
              ) : reverseWord && (
              <div className="p-8 flex flex-col items-center gap-6 text-center">
                <p className="text-[10px] font-bold uppercase text-purple-400 tracking-widest">Comment dit-on en français ?</p>
                <h3 className="text-3xl sm:text-4xl font-black text-slate-900 tracking-tight break-words">
                  {reverseWord.translation}
                </h3>

                {!reverseRevealed ? (
                  <button
                    onClick={() => { setReverseRevealed(true); speak(reverseWord.word); }}
                    className="w-full max-w-xs p-6 border-2 border-dashed border-slate-200 hover:border-purple-300 bg-slate-50/50 rounded-2xl text-slate-400 font-medium transition-all"
                  >
                    Cliquez pour voir le mot français
                  </button>
                ) : (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="w-full space-y-5">
                    <div className="p-6 bg-purple-50/50 border-2 border-purple-200 rounded-2xl space-y-2">
                      <div className="flex items-center justify-center gap-3">
                        <p className="text-2xl font-bold text-purple-700">
                          {getWordWithArticle(reverseWord.word, reverseWord.gender, reverseWord.isPlural)}
                        </p>
                        <button
                          onClick={() => speak(reverseWord.word)}
                          className="p-1.5 bg-purple-100 text-purple-600 rounded-full hover:bg-purple-200 transition-colors"
                          title="Écouter"
                        >
                          <Volume2 size={18} />
                        </button>
                      </div>
                      {reverseWord.example && (
                        <p className="text-xs text-slate-500 italic">"{cleanExample(reverseWord.example)}"</p>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <button
                        onClick={() => { if (reverseTier) resolveExerciseAnswer(reverseWord, reverseTier, false); recordExerciseActivity(); nextReverseWord(false); }}
                        className="flex items-center justify-center gap-2 p-3.5 rounded-xl border border-red-100 hover:bg-red-50 transition-colors text-red-500 font-bold text-xs uppercase tracking-widest"
                      >
                        <XCircle size={18} />
                        À revoir
                      </button>
                      <button
                        onClick={() => { if (reverseTier) resolveExerciseAnswer(reverseWord, reverseTier, true); recordExerciseActivity(); nextReverseWord(true); }}
                        className="flex items-center justify-center gap-2 p-3.5 rounded-xl border border-emerald-100 hover:bg-emerald-50 transition-colors text-emerald-600 font-bold text-xs uppercase tracking-widest"
                      >
                        <CheckCircle2 size={18} />
                        Je savais
                      </button>
                    </div>
                  </motion.div>
                )}
              </div>
              )}
            </motion.div>
          </div>
        )}

        {/* Quiz Modal: French word + 4 translation choices */}
        {isQuizModalOpen && (
          <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-[200] flex items-center justify-center p-4 sm:p-6">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-3xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-emerald-50 text-emerald-600 rounded-xl">
                    <CheckCircle2 size={24} />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-slate-900">Quiz</h3>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                      {quizSessionOver ? 'Session terminée' : `Mot ${quizSession.done + 1} sur ${EXERCISE_SESSION_SIZE}`}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (quizWord && quizTier && quizSelected === null) {
                      setExerciseBuckets(prev => ({ ...prev, [quizTier]: [quizWord, ...prev[quizTier]] }));
                    }
                    setIsQuizModalOpen(false);
                    setQuizWord(null);
                    setQuizTier(null);
                    cancelCombo();
                  }}
                  className="p-2 hover:bg-slate-100 rounded-full text-slate-400 transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              {quizSessionOver ? (
                <div className="p-8 flex flex-col items-center gap-6 text-center">
                  <div className="w-16 h-16 bg-emerald-50 text-emerald-500 rounded-full flex items-center justify-center">
                    <CheckCircle2 size={32} />
                  </div>
                  <div>
                    <p className="text-3xl font-black text-slate-900">{Math.round((quizSession.correct / Math.max(1, quizSession.done)) * 100)}%</p>
                    <p className="text-sm text-slate-500 mt-1">{quizSession.correct} / {quizSession.done} bonnes réponses</p>
                  </div>
                  {comboMode === 'quiz' ? (
                    <button
                      onClick={() => {
                        setComboResults(prev => ({ ...prev, quiz: { correct: quizSession.correct, total: quizSession.done } }));
                        setIsQuizModalOpen(false);
                        setComboMode('typing');
                        startTypingActivity(5);
                      }}
                      className="w-full py-3.5 bg-amber-500 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-amber-600 active:scale-[0.98] transition-all shadow-lg shadow-amber-100 flex items-center justify-center gap-2"
                    >
                      <Keyboard size={16} />
                      Continuer : Écrivez le mot
                    </button>
                  ) : (
                    <button
                      onClick={startQuizGame}
                      className="w-full py-3.5 bg-indigo-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-indigo-700 active:scale-[0.98] transition-all shadow-lg shadow-indigo-100 flex items-center justify-center gap-2"
                    >
                      <Sparkles size={16} />
                      Nouvelle session
                    </button>
                  )}
                </div>
              ) : quizWord && (
              <div className="p-8 flex flex-col items-center gap-6">
                <div className="flex items-center gap-3">
                  <h3 className="text-3xl sm:text-4xl font-black text-slate-900 tracking-tight break-words text-center">
                    {getWordWithArticle(quizWord.word, quizWord.gender, quizWord.isPlural)}
                  </h3>
                  <button
                    onClick={() => speak(quizWord.word)}
                    className="p-2 bg-indigo-50 text-indigo-600 rounded-full hover:bg-indigo-100 transition-colors shrink-0"
                    title="Écouter"
                  >
                    <Volume2 size={20} />
                  </button>
                </div>

                {quizOptions.length === 0 && (
                  <div className="w-full py-10 flex flex-col items-center gap-3">
                    <div className="relative w-10 h-10">
                      <div className="absolute inset-0 border-4 border-emerald-100 rounded-full"></div>
                      <div className="absolute inset-0 border-4 border-emerald-500 rounded-full border-t-transparent animate-spin"></div>
                    </div>
                    <p className="text-xs text-slate-400 font-medium animate-pulse">Préparation des options...</p>
                  </div>
                )}

                <div className="w-full grid grid-cols-1 gap-2.5">
                  {quizOptions.map((opt) => {
                    const isCorrectOpt = normalizeWord(opt) === normalizeWord(quizWord.translation);
                    const isChosen = quizSelected === opt;
                    return (
                      <button
                        key={opt}
                        disabled={quizSelected !== null}
                        onClick={() => {
                          setQuizSelected(opt);
                          if (quizTier) resolveExerciseAnswer(quizWord, quizTier, isCorrectOpt);
                          recordExerciseActivity();
                          if (isCorrectOpt) setTimeout(() => advanceQuiz(true), 900);
                        }}
                        className={`w-full p-4 rounded-2xl border-2 font-bold text-sm transition-all text-center ${
                          quizSelected === null
                            ? 'bg-white border-slate-200 text-slate-700 hover:border-emerald-300 hover:bg-emerald-50/50 active:scale-[0.98]'
                            : isCorrectOpt
                              ? 'bg-emerald-50 border-emerald-500 text-emerald-700'
                              : isChosen
                                ? 'bg-red-50 border-red-400 text-red-600'
                                : 'bg-slate-50 border-slate-100 text-slate-300'
                        }`}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>

                {quizSelected !== null && normalizeWord(quizSelected) !== normalizeWord(quizWord.translation) && (
                  <motion.button
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    onClick={() => advanceQuiz(false)}
                    className="w-full py-3.5 bg-indigo-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-indigo-700 active:scale-[0.98] transition-all shadow-lg shadow-indigo-100"
                  >
                    Suivant
                  </motion.button>
                )}
              </div>
              )}
            </motion.div>
          </div>
        )}

        {/* Typing Modal: type the French word from its translation */}
        {isTypingModalOpen && (
          <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-[200] flex items-center justify-center p-4 sm:p-6">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-3xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-amber-50 text-amber-600 rounded-xl">
                    <Keyboard size={24} />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-slate-900">Écrivez le mot</h3>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                      {typingSessionOver ? 'Session terminée' : `Mot ${typingSession.done + 1} sur ${typingLimit}`}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (typingWord && typingTier && typingResult === null) {
                      setExerciseBuckets(prev => ({ ...prev, [typingTier]: [typingWord, ...prev[typingTier]] }));
                    }
                    setIsTypingModalOpen(false);
                    setTypingWord(null);
                    setTypingTier(null);
                    cancelCombo();
                  }}
                  className="p-2 hover:bg-slate-100 rounded-full text-slate-400 transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              {typingSessionOver ? (
                <div className="p-8 flex flex-col items-center gap-6 text-center">
                  <div className="w-16 h-16 bg-amber-50 text-amber-500 rounded-full flex items-center justify-center">
                    <CheckCircle2 size={32} />
                  </div>
                  <div>
                    <p className="text-3xl font-black text-slate-900">{Math.round((typingSession.correct / Math.max(1, typingSession.done)) * 100)}%</p>
                    <p className="text-sm text-slate-500 mt-1">{typingSession.correct} / {typingSession.done} mots écrits correctement</p>
                  </div>
                  {comboMode === 'typing' ? (
                    <button
                      onClick={() => {
                        setComboResults(prev => ({ ...prev, typing: { correct: typingSession.correct, total: typingSession.done } }));
                        setIsTypingModalOpen(false);
                        setComboMode('text');
                        openTextExercise();
                        generateStoryExercise();
                      }}
                      className="w-full py-3.5 bg-indigo-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-indigo-700 active:scale-[0.98] transition-all shadow-lg shadow-indigo-100 flex items-center justify-center gap-2"
                    >
                      <FileText size={16} />
                      Continuer : Phrases à compléter
                    </button>
                  ) : (
                    <button
                      onClick={startTypingActivity}
                      className="w-full py-3.5 bg-amber-500 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-amber-600 active:scale-[0.98] transition-all shadow-lg shadow-amber-100 flex items-center justify-center gap-2"
                    >
                      <Sparkles size={16} />
                      Nouvelle session
                    </button>
                  )}
                </div>
              ) : typingWord && (
              <div className="p-8 flex flex-col items-center gap-5 text-center">
                <p className="text-[10px] font-bold uppercase text-amber-500 tracking-widest">Écrivez en français :</p>
                <h3 className="text-3xl font-black text-slate-900 tracking-tight break-words">
                  {typingWord.translation}
                </h3>

                <div className="w-full space-y-3">
                  <input
                    type="text"
                    autoFocus
                    value={typingInput}
                    onChange={(e) => setTypingInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (typingResult === null ? checkTypingAnswer() : typingResult === 'wrong' && nextTypingWord(false))}
                    disabled={typingResult !== null}
                    placeholder="Tapez le mot français..."
                    className={`w-full px-4 py-3.5 border-2 rounded-2xl outline-none transition-all font-semibold text-lg text-center ${
                      typingResult === 'correct'
                        ? 'bg-emerald-50 border-emerald-400 text-emerald-700'
                        : typingResult === 'wrong'
                          ? 'bg-red-50 border-red-300 text-red-600'
                          : 'bg-white border-amber-300 focus:border-amber-500 focus:ring-4 focus:ring-amber-100'
                    }`}
                  />

                  <div className="flex flex-wrap justify-center gap-1">
                    {['é', 'è', 'ê', 'à', 'â', 'ç', 'î', 'ô', 'û', 'ù', 'ë', 'œ'].map(char => (
                      <button
                        key={char}
                        disabled={typingResult !== null}
                        onClick={() => setTypingInput(prev => prev + char)}
                        className="w-8 h-8 bg-slate-50 border border-slate-200 rounded-lg text-sm font-bold text-slate-600 hover:bg-amber-50 hover:border-amber-300 transition-colors disabled:opacity-40"
                      >
                        {char}
                      </button>
                    ))}
                  </div>
                </div>

                {typingResult === 'wrong' && (
                  <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="w-full space-y-3">
                    <div className="p-4 bg-emerald-50 border-2 border-emerald-200 rounded-2xl flex items-center justify-center gap-3">
                      <p className="text-xl font-bold text-emerald-700">
                        {getWordWithArticle(typingWord.word, typingWord.gender, typingWord.isPlural)}
                      </p>
                      <button
                        onClick={() => speak(typingWord.word)}
                        className="p-1.5 bg-emerald-100 text-emerald-600 rounded-full hover:bg-emerald-200 transition-colors"
                        title="Écouter"
                      >
                        <Volume2 size={16} />
                      </button>
                    </div>
                    <button
                      onClick={() => nextTypingWord(false)}
                      className="w-full py-3.5 bg-indigo-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-indigo-700 active:scale-[0.98] transition-all shadow-lg shadow-indigo-100"
                    >
                      Suivant
                    </button>
                  </motion.div>
                )}

                {typingResult === null && (
                  <button
                    onClick={checkTypingAnswer}
                    disabled={!typingInput.trim()}
                    className={`w-full py-3.5 rounded-2xl font-bold text-sm uppercase tracking-widest transition-all shadow-lg ${
                      typingInput.trim()
                        ? 'bg-amber-500 text-white hover:bg-amber-600 active:scale-[0.98] shadow-amber-100'
                        : 'bg-slate-100 text-slate-400 shadow-none cursor-not-allowed'
                    }`}
                  >
                    Vérifier
                  </button>
                )}
              </div>
              )}
            </motion.div>
          </div>
        )}

        {/* Compose Modal: write a sentence with the word, AI checks it */}
        {isComposeModalOpen && (
          <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-[200] flex items-center justify-center p-4 sm:p-6">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-3xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden max-h-[90vh] overflow-y-auto"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-rose-50 text-rose-600 rounded-xl">
                    <Edit2 size={24} />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-slate-900">Composez une phrase</h3>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                      {composeSessionOver ? 'Session terminée' : `Mot ${composeSession.done + 1} sur ${composeLimit}`}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (composeWord && composeTier && !composeFeedback) {
                      setExerciseBuckets(prev => ({ ...prev, [composeTier]: [composeWord, ...prev[composeTier]] }));
                    }
                    setIsComposeModalOpen(false);
                    setComposeWord(null);
                    setComposeTier(null);
                    cancelCombo();
                  }}
                  className="p-2 hover:bg-slate-100 rounded-full text-slate-400 transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              {composeSessionOver ? (
                <div className="p-8 flex flex-col items-center gap-6 text-center">
                  <div className="w-16 h-16 bg-rose-50 text-rose-500 rounded-full flex items-center justify-center">
                    <CheckCircle2 size={32} />
                  </div>
                  <div>
                    <p className="text-3xl font-black text-slate-900">{Math.round((composeSession.correct / Math.max(1, composeSession.done)) * 100)}%</p>
                    <p className="text-sm text-slate-500 mt-1">{composeSession.correct} / {composeSession.done} phrases réussies</p>
                  </div>
                  {comboMode === 'compose' ? (
                    <button
                      onClick={() => {
                        setComboResults(prev => ({ ...prev, compose: { correct: composeSession.correct, total: composeSession.done } }));
                        setIsComposeModalOpen(false);
                        setComboMode(null);
                        setIsComboSummaryOpen(true);
                      }}
                      className="w-full py-3.5 bg-gradient-to-br from-indigo-500 to-purple-500 text-white rounded-2xl font-bold text-sm uppercase tracking-widest active:scale-[0.98] transition-all shadow-lg shadow-indigo-100 flex items-center justify-center gap-2"
                    >
                      <Zap size={16} />
                      Voir le bilan
                    </button>
                  ) : (
                    <button
                      onClick={startComposeActivity}
                      className="w-full py-3.5 bg-rose-500 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-rose-600 active:scale-[0.98] transition-all shadow-lg shadow-rose-100 flex items-center justify-center gap-2"
                    >
                      <Sparkles size={16} />
                      Nouvelle session
                    </button>
                  )}
                </div>
              ) : composeWord && (
              <div className="p-6 sm:p-8 flex flex-col gap-5">
                <div className="text-center space-y-1">
                  <p className="text-[10px] font-bold uppercase text-rose-500 tracking-widest">Écrivez une phrase avec :</p>
                  <div className="flex items-center justify-center gap-2">
                    <h3 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight break-words">
                      {getWordWithArticle(composeWord.word, composeWord.gender, composeWord.isPlural)}
                    </h3>
                    <button
                      onClick={() => speak(composeWord.word)}
                      className="p-1.5 bg-rose-50 text-rose-500 rounded-full hover:bg-rose-100 transition-colors shrink-0"
                      title="Écouter"
                    >
                      <Volume2 size={16} />
                    </button>
                  </div>
                  <p className="text-sm text-slate-400">({composeWord.translation})</p>
                </div>

                <textarea
                  value={composeInput}
                  onChange={(e) => setComposeInput(e.target.value)}
                  disabled={!!composeFeedback || composeChecking}
                  placeholder="Votre phrase en français..."
                  className={`w-full h-24 px-4 py-3 border-2 rounded-2xl outline-none transition-all font-medium resize-none ${
                    composeFeedback
                      ? composeFeedback.wordOk
                        ? 'bg-emerald-50/50 border-emerald-300'
                        : 'bg-red-50/50 border-red-300'
                      : 'bg-white border-rose-300 focus:border-rose-500 focus:ring-4 focus:ring-rose-100'
                  }`}
                />

                {composeFeedback && (
                  <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
                    <div className={`p-4 rounded-2xl border-2 space-y-2 ${composeFeedback.wordOk ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                      <p className={`text-xs font-bold uppercase tracking-widest ${composeFeedback.wordOk ? 'text-emerald-600' : 'text-red-500'}`}>
                        {composeFeedback.wordOk ? '✓ Mot bien utilisé' : '✗ À retravailler'}
                      </p>
                      {composeFeedback.corrected && normalizeWord(composeFeedback.corrected) !== normalizeWord(composeInput.trim()) && (
                        <p className="text-sm font-semibold text-slate-700 italic">"{composeFeedback.corrected}"</p>
                      )}
                      {composeFeedback.feedback && (
                        <p className="text-xs text-slate-600 leading-relaxed">{composeFeedback.feedback}</p>
                      )}
                    </div>
                    <button
                      onClick={nextComposeWord}
                      className="w-full py-3.5 bg-indigo-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-indigo-700 active:scale-[0.98] transition-all shadow-lg shadow-indigo-100"
                    >
                      Mot suivant
                    </button>
                  </motion.div>
                )}

                {!composeFeedback && (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={skipComposeWord}
                      disabled={composeChecking}
                      className="px-4 py-3.5 rounded-2xl border-2 border-slate-200 text-slate-500 font-bold text-xs uppercase tracking-widest hover:bg-slate-50 hover:border-slate-300 active:scale-[0.98] transition-all shrink-0 disabled:opacity-40 flex items-center gap-1.5"
                      title="Passer ce mot — il reviendra plus tard"
                    >
                      <ChevronRight size={16} />
                      Passer
                    </button>
                    <button
                      onClick={checkComposeSentence}
                      disabled={composeChecking || composeInput.trim().length < 3}
                      className={`flex-1 py-3.5 rounded-2xl font-bold text-sm uppercase tracking-widest transition-all shadow-lg flex items-center justify-center gap-2 ${
                        composeChecking
                          ? 'bg-rose-300 text-white cursor-wait'
                          : composeInput.trim().length >= 3
                            ? 'bg-rose-500 text-white hover:bg-rose-600 active:scale-[0.98] shadow-rose-100'
                            : 'bg-slate-100 text-slate-400 shadow-none cursor-not-allowed'
                      }`}
                    >
                      {composeChecking ? (<><Loader2 size={16} className="animate-spin" /> Vérification...</>) : 'Vérifier ma phrase'}
                    </button>
                  </div>
                )}
              </div>
              )}
            </motion.div>
          </div>
        )}

        {/* Combo Session Summary Modal */}
        {isComboSummaryOpen && (() => {
          const phases: { key: ComboPhase; label: string; icon: React.ReactElement; chip: string }[] = [
            { key: 'reverse', label: 'Rappel actif', icon: <Languages size={16} />, chip: 'bg-purple-100 text-purple-600' },
            { key: 'match', label: 'Relier les mots', icon: <Grid2X2 size={16} />, chip: 'bg-indigo-100 text-indigo-600' },
            { key: 'quiz', label: 'Quiz', icon: <CheckCircle2 size={16} />, chip: 'bg-emerald-100 text-emerald-600' },
            { key: 'typing', label: 'Écrivez le mot', icon: <Keyboard size={16} />, chip: 'bg-amber-100 text-amber-600' },
            { key: 'text', label: 'Phrases à compléter', icon: <FileText size={16} />, chip: 'bg-indigo-100 text-indigo-600' },
            { key: 'compose', label: 'Composez une phrase', icon: <Edit2 size={16} />, chip: 'bg-rose-100 text-rose-600' },
          ];
          const totalCorrect = phases.reduce((s, p) => s + comboResults[p.key].correct, 0);
          const totalDone = phases.reduce((s, p) => s + comboResults[p.key].total, 0);
          const overallPct = Math.round((totalCorrect / Math.max(1, totalDone)) * 100);
          return (
            <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-[200] flex items-center justify-center p-4 sm:p-6">
              <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="bg-white rounded-3xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden"
              >
                <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-gradient-to-br from-indigo-500 to-purple-500 text-white rounded-xl">
                      <Zap size={24} />
                    </div>
                    <div>
                      <h3 className="text-xl font-bold text-slate-900">Session complète</h3>
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">{totalDone} mots au total</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setIsComboSummaryOpen(false)}
                    className="p-2 hover:bg-slate-100 rounded-full text-slate-400 transition-colors"
                  >
                    <X size={20} />
                  </button>
                </div>

                <div className="p-8 flex flex-col items-center gap-6 text-center">
                  <div>
                    <p className="text-4xl font-black text-slate-900">{overallPct}%</p>
                    <p className="text-sm text-slate-500 mt-1">{totalCorrect} / {totalDone} bonnes réponses au total</p>
                  </div>

                  <div className="w-full space-y-2">
                    {phases.map(p => {
                      const r = comboResults[p.key];
                      const pct = r.total > 0 ? Math.round((r.correct / r.total) * 100) : 0;
                      return (
                        <div key={p.key} className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl">
                          <div className={`p-1.5 rounded-lg ${p.chip}`}>{p.icon}</div>
                          <span className="flex-1 text-left text-sm font-bold text-slate-700">{p.label}</span>
                          <span className="text-xs font-bold text-slate-500">{r.correct}/{r.total}</span>
                          <span className="text-xs font-black text-slate-900 w-10 text-right">{pct}%</span>
                        </div>
                      );
                    })}
                  </div>

                  <button
                    onClick={() => { setIsComboSummaryOpen(false); startComboSession(); }}
                    className="w-full py-3.5 bg-gradient-to-br from-indigo-500 to-purple-500 text-white rounded-2xl font-bold text-sm uppercase tracking-widest active:scale-[0.98] transition-all shadow-lg shadow-indigo-100 flex items-center justify-center gap-2"
                  >
                    <Zap size={16} />
                    Nouvelle session complète
                  </button>
                </div>
              </motion.div>
            </div>
          );
        })()}

        {/* Statistics Modal */}
        {isStatsModalOpen && (() => {
          const days: { key: string; label: string; cards: number; exercises: number }[] = [];
          for (let i = 13; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = dayKey(d);
            days.push({
              key,
              label: `${d.getDate()}/${d.getMonth() + 1}`,
              cards: activityLog[key] || 0,
              exercises: exerciseLog[key] || 0,
            });
          }
          const maxVal = Math.max(1, ...days.map(d => Math.max(d.cards, d.exercises)));
          const totalCards = days.reduce((s, d) => s + d.cards, 0);
          const totalEx = days.reduce((s, d) => s + d.exercises, 0);
          const ps = progressStats;
          const fmtDate = (ts: number) => new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
          const maxStage = Math.max(1, ...ps.stages.map(s => s.count));
          const seenPct = ps.total > 0 ? Math.round((ps.seenCount / ps.total) * 100) : 0;

          return (
            <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-[200] flex items-center justify-center p-4 sm:p-6">
              <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden max-h-[92vh]"
              >
                <div className="p-6 border-b border-slate-100 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
                      <BarChart3 size={24} />
                    </div>
                    <div>
                      <h3 className="text-xl font-bold text-slate-900">Statistiques</h3>
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                        {ps.total} mots · {seenPct}% déjà vus
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setIsStatsModalOpen(false)}
                    className="p-2 hover:bg-slate-100 rounded-full text-slate-400 transition-colors"
                  >
                    <X size={20} />
                  </button>
                </div>

                <div className="p-6 space-y-7 overflow-y-auto">
                  <div className="grid grid-cols-4 gap-2.5 text-center">
                    <div className="p-3 bg-slate-50 rounded-2xl">
                      <p className="text-xl font-black text-slate-900">{ps.total}</p>
                      <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">Mots</p>
                    </div>
                    <div className="p-3 bg-indigo-50 rounded-2xl">
                      <p className="text-xl font-black text-indigo-600">{ps.seenCount}</p>
                      <p className="text-[9px] font-bold uppercase tracking-widest text-indigo-400">Déjà vus</p>
                    </div>
                    <div className="p-3 bg-emerald-50 rounded-2xl">
                      <p className="text-xl font-black text-emerald-600">{masteredCount}</p>
                      <p className="text-[9px] font-bold uppercase tracking-widest text-emerald-400">Appris</p>
                    </div>
                    <div className="p-3 bg-orange-50 rounded-2xl">
                      <p className="text-xl font-black text-orange-500">🔥{streak}</p>
                      <p className="text-[9px] font-bold uppercase tracking-widest text-orange-400">Jours</p>
                    </div>
                  </div>

                  {/* Where every word sits on the interval ladder */}
                  <div className="space-y-3">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Répartition par intervalle</p>
                    <div className="space-y-1.5">
                      {ps.stages.map(s => (
                        <div key={s.label} className="flex items-center gap-3">
                          <span className="w-16 text-[10px] font-bold uppercase tracking-widest text-slate-500 text-right shrink-0">
                            {s.label}
                          </span>
                          <div className="flex-1 h-5 bg-slate-50 rounded-lg overflow-hidden">
                            <div
                              className={`h-full ${s.color} rounded-lg transition-all`}
                              style={{ width: `${(s.count / maxStage) * 100}%`, minWidth: s.count > 0 ? '4px' : '0' }}
                            />
                          </div>
                          <span className="w-10 text-xs font-black text-slate-700 text-right shrink-0">{s.count}</span>
                        </div>
                      ))}
                    </div>
                    <p className="text-[10px] text-slate-400 leading-snug">
                      Chaque mot monte l'échelle 1 → 3 → 7 → 14 → 30 jours, puis devient « Appris ».
                      Une erreur dans une activité le fait redescendre d'un cran.
                    </p>
                  </div>

                  {/* Forecast: how much work is coming, over the chosen horizon */}
                  {(() => {
                    const ranges: { days: 30 | 90 | 180 | 365; label: string }[] = [
                      { days: 30, label: '1 mois' },
                      { days: 90, label: '3 mois' },
                      { days: 180, label: '6 mois' },
                      { days: 365, label: '1 an' },
                    ];
                    // Longer horizons are grouped so the chart stays readable
                    const bucketDays = forecastRange <= 30 ? 1 : forecastRange <= 90 ? 7 : forecastRange <= 180 ? 14 : 30;
                    const slice = ps.forecast.slice(0, forecastRange);
                    const buckets: { ts: number; load: number; saturated: boolean; days: number }[] = [];
                    for (let i = 0; i < slice.length; i += bucketDays) {
                      const chunk = slice.slice(i, i + bucketDays);
                      buckets.push({
                        ts: chunk[0].ts,
                        load: chunk.reduce((s, f) => s + f.load, 0),
                        saturated: chunk.some(f => f.backlog > 0),
                        days: chunk.length,
                      });
                    }
                    const maxBucket = Math.max(1, ...buckets.map(b => b.load));
                    const periodTotal = buckets.reduce((s, b) => s + b.load, 0);
                    const unitLabel = bucketDays === 1 ? 'jour' : bucketDays === 30 ? 'mois' : `${bucketDays} j`;
                    const labelEvery = Math.max(1, Math.ceil(buckets.length / 6));
                    const fmtBucket = (ts: number) => bucketDays >= 30
                      ? new Date(ts).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' })
                      : fmtDate(ts);

                    return (
                      <div className="space-y-3">
                        <div className="flex items-baseline justify-between gap-3 flex-wrap">
                          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Charge prévue</p>
                          <span className="text-[10px] font-bold text-indigo-500">
                            {periodTotal} cartes au total · max {maxBucket}/{unitLabel}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5">
                          {ranges.map(r => (
                            <button
                              key={r.days}
                              onClick={() => setForecastRange(r.days)}
                              className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all ${
                                forecastRange === r.days
                                  ? 'bg-indigo-600 text-white shadow-sm'
                                  : 'bg-slate-50 text-slate-400 hover:bg-slate-100'
                              }`}
                            >
                              {r.label}
                            </button>
                          ))}
                        </div>

                        <div className="flex items-end justify-between gap-[2px] h-28 pb-4">
                          {buckets.map((b, i) => (
                            <div key={b.ts} className="flex-1 h-full flex flex-col justify-end group relative">
                              <div className="absolute -top-8 left-1/2 -translate-x-1/2 hidden group-hover:block bg-slate-800 text-white text-[9px] font-bold px-2 py-1 rounded-lg whitespace-nowrap z-10">
                                {fmtBucket(b.ts)}{bucketDays > 1 ? ` (${b.days} j)` : ''} · {b.load} cartes{b.saturated ? ' · saturé' : ''}
                              </div>
                              <div
                                className={`w-full rounded-t-sm min-h-[2px] ${b.saturated ? 'bg-red-400' : 'bg-indigo-400'}`}
                                style={{ height: `${(b.load / maxBucket) * 100}%`, opacity: b.load ? 1 : 0.15 }}
                              />
                              {i % labelEvery === 0 && (
                                <span className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[7px] font-bold text-slate-400 whitespace-nowrap">
                                  {fmtBucket(b.ts)}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>

                        <div className="flex items-center gap-4 flex-wrap">
                          <span className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-widest text-slate-500">
                            <span className="w-2.5 h-2.5 bg-indigo-400 rounded-sm inline-block" /> Dans la limite
                          </span>
                          <span className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-widest text-slate-500">
                            <span className="w-2.5 h-2.5 bg-red-400 rounded-sm inline-block" /> Limite atteinte
                          </span>
                          {bucketDays > 1 && (
                            <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">
                              1 barre = {bucketDays} jours
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Plain-language timeline answer */}
                  <div className="p-4 bg-indigo-50/60 border border-indigo-100 rounded-2xl space-y-2">
                    {ps.unseenCount > 0 ? (
                      <p className="text-sm text-slate-700 leading-relaxed">
                        <span className="font-bold">{ps.unseenCount} mots</span> n'ont jamais été vus.
                        {ps.allSeenDayIdx !== null
                          ? <> En révisant chaque jour, vous les aurez tous vus au moins une fois vers le{' '}
                              <span className="font-bold text-indigo-600">
                                {fmtDate(ps.forecast[ps.allSeenDayIdx].ts)}
                              </span>{' '}
                              (dans {ps.allSeenDayIdx + 1} jours).
                            </>
                          : <> Au rythme de {DAILY_NEW_LIMIT} nouveaux mots par jour, il faudra plus de {ps.horizon} jours pour tous les voir.</>}
                      </p>
                    ) : (
                      <p className="text-sm text-slate-700 leading-relaxed">
                        <span className="font-bold text-emerald-600">Tous vos mots ont déjà été vus au moins une fois.</span>{' '}
                        Il ne reste que les répétitions programmées.
                      </p>
                    )}
                    {overdueCount > 0 && (
                      <p className="text-xs text-red-500 font-medium">
                        ⏰ {overdueCount} révisions en retard — elles passent avant les nouveaux mots.
                      </p>
                    )}
                    <p className="text-[10px] text-slate-400 leading-snug">
                      Prévision optimiste : elle suppose que chaque révision réussit. Un jour sauté décale la courbe
                      et fait grossir le retard — rouvrez cet écran pour la voir se recalculer.
                    </p>
                  </div>

                  {/* Actual activity history */}
                  <div className="space-y-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Activité réelle (14 jours)</p>
                      <span className="text-[10px] font-bold text-slate-400">{totalCards} cartes · {totalEx} exercices</span>
                    </div>
                    <div className="flex items-end justify-between gap-1 h-32 px-1">
                      {days.map(d => (
                        <div key={d.key} className="flex-1 flex flex-col items-center justify-end gap-0.5 h-full group relative">
                          <div className="absolute -top-7 hidden group-hover:block bg-slate-800 text-white text-[9px] font-bold px-2 py-1 rounded-lg whitespace-nowrap z-10">
                            {d.cards} cartes · {d.exercises} ex.
                          </div>
                          <div className="w-full flex items-end justify-center gap-[2px] flex-1">
                            <div
                              className="w-[40%] bg-indigo-400 rounded-t-sm min-h-[2px]"
                              style={{ height: `${(d.cards / maxVal) * 100}%`, opacity: d.cards ? 1 : 0.15 }}
                            />
                            <div
                              className="w-[40%] bg-emerald-400 rounded-t-sm min-h-[2px]"
                              style={{ height: `${(d.exercises / maxVal) * 100}%`, opacity: d.exercises ? 1 : 0.15 }}
                            />
                          </div>
                          <span className="text-[7px] font-bold text-slate-400 rotate-0">{d.label}</span>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center justify-center gap-4">
                      <span className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-widest text-slate-500">
                        <span className="w-2.5 h-2.5 bg-indigo-400 rounded-sm inline-block" /> Cartes
                      </span>
                      <span className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-widest text-slate-500">
                        <span className="w-2.5 h-2.5 bg-emerald-400 rounded-sm inline-block" /> Exercices
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-snug">
                      L'historique démarre au moment où cette fonction a été ajoutée : les jours antérieurs
                      apparaissent vides même si vous avez travaillé.
                    </p>
                  </div>
                </div>
              </motion.div>
            </div>
          );
        })()}
      </AnimatePresence>

      {/* Footer */}
      <footer className="max-w-7xl mx-auto px-6 py-12 border-t border-slate-100">
        <div className="flex flex-col md:flex-row items-center justify-between gap-8">
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 text-slate-400">
              <Languages size={16} />
              <span className="text-xs font-bold uppercase tracking-widest">Mon Vocabulaire Français-{currentLangObj.name}</span>
            </div>
            
            <div className="relative group">
              <select
                value={targetLanguage}
                onChange={(e) => confirmLanguageChange(e.target.value)}
                className="appearance-none w-full md:w-48 pl-4 pr-10 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-bold text-slate-700 uppercase tracking-widest outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all cursor-pointer"
              >
                {languages.map(lang => (
                  <option key={lang.id} value={lang.id}>
                    {lang.flag} {lang.name}
                  </option>
                ))}
              </select>
              <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400 group-hover:text-indigo-500 transition-colors">
                <ChevronDown size={14} />
              </div>
            </div>
          </div>

          {/* Central: Statistics */}
          <div className="flex items-center gap-4">
            <button
              onClick={() => setIsStatsModalOpen(true)}
              className="flex items-center gap-3 px-6 py-3 bg-indigo-50 text-indigo-600 rounded-2xl hover:bg-indigo-100 transition-all border-2 border-indigo-100 shadow-sm active:scale-95 font-bold text-xs uppercase tracking-widest"
              title="Statistiques"
            >
              <BarChart3 size={20} />
              Statistiques
            </button>
          </div>

          <div className="flex flex-col items-center md:items-end gap-3 text-center md:text-right">
            <p className="text-[10px] text-slate-400 font-medium italic mb-1">
              "La langue est la clé de la culture."
            </p>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                <span className="text-[10px] font-bold uppercase text-slate-400">Local Storage Active</span>
              </div>
              <span className="text-[8px] font-bold text-slate-300 uppercase tracking-widest">v2.8.0</span>
              <button 
                onClick={handleHardReset} 
                className="p-1 hover:bg-red-50 rounded text-red-300 hover:text-red-500 transition-colors"
                title="Réinitialiser et mettre à jour l'application"
              >
                <RefreshCw size={10} />
              </button>
            </div>
          </div>
        </div>
      </footer>

      {/* Translation Prompt Modal */}
      <AnimatePresence>
        {isTranslationPromptOpen && pendingTargetLang && (
          <div className="fixed inset-0 z-[1000] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsTranslationPromptOpen(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative w-full max-w-sm bg-white rounded-3xl shadow-2xl p-8 text-center"
            >
              <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
                <RefreshCw size={32} />
              </div>
              <h3 className="text-xl font-bold text-slate-900">Traduire la bibliothèque ?</h3>
              <p className="text-sm text-slate-500 mt-3 leading-relaxed">
                Voulez-vous adapter vos <span className="font-bold text-indigo-600">{words.length} mots</span> pour le <span className="font-bold text-indigo-600">{languages.find(l => l.id === pendingTargetLang)?.name}</span> ?
              </p>
              
              <div className="flex flex-col gap-3 mt-8">
                <button 
                  onClick={() => {
                    const lang = pendingTargetLang;
                    setTargetLanguage(lang);
                    setIsTranslationPromptOpen(false);
                    setPendingTargetLang(null);
                    translateLibrary(lang);
                  }}
                  className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-bold text-xs uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100"
                >
                  Traduire tout maintenant
                </button>
                <button 
                  onClick={() => {
                    setTargetLanguage(pendingTargetLang);
                    setIsTranslationPromptOpen(false);
                    setPendingTargetLang(null);
                  }}
                  className="w-full py-3 bg-slate-50 text-slate-500 rounded-2xl font-bold text-xs uppercase tracking-widest hover:bg-slate-100 transition-all"
                >
                  Changer seulement la langue
                </button>
                <button 
                  onClick={() => {
                    setIsTranslationPromptOpen(false);
                    setPendingTargetLang(null);
                  }}
                  className="w-full py-2 text-slate-400 font-bold text-[10px] uppercase tracking-widest hover:text-slate-600 transition-all"
                >
                  Annuler
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Translating Overlay */}
      <AnimatePresence>
        {isTranslatingLibrary && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[1000] flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white p-8 rounded-3xl shadow-2xl flex flex-col items-center gap-6 max-w-sm text-center"
            >
              <div className="p-4 bg-indigo-50 text-indigo-600 rounded-2xl animate-bounce">
                <Languages size={40} />
              </div>
              <div>
                <h3 className="text-xl font-bold text-slate-900 mb-2">Traduction de la bibliothèque</h3>
                <p className="text-sm text-slate-500 leading-relaxed">
                  Nous adaptons vos mots pour le <span className="font-bold text-indigo-600">{currentLangObj.name}</span>. 
                  Cela peut prendre quelques instants selon la taille de votre liste.
                </p>
              </div>
              <div className="flex items-center gap-2 text-indigo-600 font-bold text-xs uppercase tracking-widest">
                <Loader2 size={16} className="animate-spin" />
                En cours...
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
