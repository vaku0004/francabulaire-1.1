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
  Edit2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist';
import { Word, ReviewGrade } from './types';
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { auth, db, googleProvider } from './lib/firebase';
import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import { doc, setDoc, getDoc, onSnapshot } from 'firebase/firestore';

// Set up PDF.js worker using CDN (ESM version for 5.x)
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

const STORAGE_KEY = 'mon_francais_vocab';
const REVIEW_INTERVALS = [1, 3, 7, 14, 30]; // Spaced repetition intervals in days

function extractJson(response: any): string {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (parts) {
    const text = parts.filter((p: any) => !p.thought).map((p: any) => p.text || '').join('');
    if (text) return text;
  }
  return response?.text || '';
}

export default function App() {
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
    setIsStoryLoading(true);
    setExerciseFeedback(null);
    setUserAnswers([]);
    setWordHintIndex(null);
    
    try {
      const apiKey = process.env.GEMINI_API_KEY || (window as any).GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("Clé API не найдена.");
      }
      const ai = new GoogleGenAI({ apiKey });

      // Get 10 random words from current language
      const langWords = words.filter(w => 
        targetLanguage === 'Russe' ? (!w.target_lang || w.target_lang === 'Russe') : (w.target_lang === targetLanguage)
      );
      
      if (langWords.length < 5) {
        alert("Il vous faut au moins 5 mots dans votre bibliothèque pour générer une histoire.");
        setIsStoryLoading(false);
        return;
      }

      const selectedWords = [...langWords]
        .sort(() => Math.random() - 0.5)
        .slice(0, Math.min(10, langWords.length));
      
      const wordListStr = selectedWords.map(w => w.word).join(', ');

      const response = await ai.models.generateContent({
        model: "gemma-4-26b-a4b-it",
        contents: `Tu es un professeur de français. Crée une petite histoire cohérente et intéressante en français utilisant EXACTEMENT ces mots : ${wordListStr}.
        L'histoire doit être d'un niveau intermédiaire (B1).
        
        Retourne UNIQUEMENT un objet JSON avec :
        1. "title": un titre pour l'histoire.
        2. "story": le texte de l'histoire où chaque mot de la liste est remplacé par un marqueur comme {{0}}, {{1}}, etc. dans l'ordre d'apparition.
        3. "gaps": la liste ordonnée des mots correspondant aux marqueurs {{0}}, {{1}}, etc.
        
        Exemple : "Le {{0}} est bleu." avec gaps: ["ciel"].`,
        config: {
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              story: { type: Type.STRING },
              gaps: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ["title", "story", "gaps"]
          }
        }
      });

      const result = JSON.parse(extractJson(response) || '{}');
      if (result.story && result.gaps) {
        setGeneratedStory({
          ...result,
          shuffledGaps: [...result.gaps].sort(() => Math.random() - 0.5)
        });
        setUserAnswers(new Array(result.gaps.length).fill(''));
      }
    } catch (error) {
      console.error("Error generating story:", error);
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

        const response = await ai.models.generateContent({
          model: "gemma-4-26b-a4b-it",
          contents: `Translate these French words/expressions to ${langObj.aiName}: ${wordList}.
          
          Guidelines:
          1. Return ONLY a JSON object where keys are original French words and values are translations in ${langObj.aiName}.
          2. Use accurate, context-aware translations.
          3. Do not include articles in translations unless necessary for grammar in ${langObj.aiName}.`,
          config: {
            thinkingConfig: { thinkingBudget: 0 },
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
  }, [targetLanguage]);

  const speak = (text: string) => {
    if (!text) return;
    
    // Stop any current speech
    window.speechSynthesis.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'fr-FR';
    utterance.rate = 0.9; // Slightly slower for better clarity
    
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    
    window.speechSynthesis.speak(utterance);
  };
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
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
    const articles = ['le ', 'la ', 'les ', "l'", 'un ', 'une ', 'des '];
    if (articles.some(article => lower.startsWith(article))) {
      return word;
    }
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
  const [sessionQueue, setSessionQueue] = useState<Word[]>([]);
  const [currentReviewIndex, setCurrentReviewIndex] = useState(0);
  const [showTranslation, setShowTranslation] = useState(false);
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

  const startMatchGame = useCallback(() => {
    // Filter words for current language, having translations, and NOT mastered
    const availableWords = words.filter(w => {
      const matchesLang = targetLanguage === 'Russe' 
        ? (!w.target_lang || w.target_lang === 'Russe')
        : (w.target_lang === targetLanguage);
      return matchesLang && w.word && w.translation && w.status !== 'mastered';
    });

    if (availableWords.length < 5) {
      alert("Il faut au moins 5 mots non-maîtrisés dans votre bibliothèque pour jouer.");
      return;
    }

    // Pick 20 words or all available if less than 20
    const poolSize = Math.min(availableWords.length, 20);
    const shuffledPool = [...availableWords].sort(() => Math.random() - 0.5).slice(0, poolSize);
    
    setMatchPool(shuffledPool);
    setMatchedIds(new Set());
    
    const initialWords = shuffledPool.slice(0, 5);
    setCurrentMatchWords(initialWords);
    
    const initialTranslations = initialWords.map(w => ({ id: w.id, text: w.translation })).sort(() => Math.random() - 0.5);
    setShuffledTranslations(initialTranslations);
    
    setSelectedWordId(null);
    setSelectedTranslationId(null);
    setSuccessfullyMatched(null);
    setWrongMatch(null);
    setIsMatchModalOpen(true);
  }, [words, targetLanguage]);

  useEffect(() => {
    if (selectedWordId && selectedTranslationId && !isProcessingMatch) {
      if (selectedWordId === selectedTranslationId) {
        // MATCH!
        setIsProcessingMatch(true);
        const matchedId = selectedWordId;
        setSuccessfullyMatched(matchedId);
        
        setTimeout(() => {
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
        // WRONG
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
      const saveToFirestore = async () => {
        try {
          const userDocRef = doc(db, 'users', user.uid);
          const sanitizedWords = sanitizeForFirestore(words);
          await setDoc(userDocRef, { words: sanitizedWords }, { merge: true });
        } catch (e) {
          console.error("Error saving to Firestore:", e);
        }
      };
      saveToFirestore();
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

  // Filter words for review
  const reviewQueue = useMemo(() => {
    const now = Date.now();
    return words
      .filter(w => {
        const matchesLang = targetLanguage === 'Russe' 
          ? (!w.target_lang || w.target_lang === 'Russe')
          : (w.target_lang === targetLanguage);
        return matchesLang && w.status !== 'mastered' && w.next_review_at <= now;
      })
      .sort((a, b) => a.next_review_at - b.next_review_at);
  }, [words, isReviewing, targetLanguage]);

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
    const dueToday = reviewQueue.length;
    const totalToday = reviewedToday + dueToday;
    const progress = totalToday > 0 ? (reviewedToday / totalToday) * 100 : 0;

    return { reviewedToday, totalToday, progress };
  }, [words, reviewQueue]);

  const masteredCount = useMemo(() => words.filter(w => {
    const matchesLang = targetLanguage === 'Russe' 
      ? (!w.target_lang || w.target_lang === 'Russe')
      : (w.target_lang === targetLanguage);
    return matchesLang && w.status === 'mastered';
  }).length, [words, targetLanguage]);
  const isDayComplete = reviewQueue.length === 0 && words.length > 0;

  const startReview = () => {
    setSessionQueue([...reviewQueue]);
    setCurrentReviewIndex(0);
    setIsReviewing(true);
  };

  const stopReview = () => {
    setIsReviewing(false);
    setSessionQueue([]);
    setCurrentReviewIndex(0);
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

    const timeoutId = setTimeout(() => {
      setIsSearching(false);
      setError(`Le mot "${trimmedQuery}" n'a pas été trouvé.`);
    }, 30000);

    try {
      // Robust API key detection in frontend
      const apiKey = process.env.GEMINI_API_KEY || (window as any).GEMINI_API_KEY;
      console.log('[DEBUG] apiKey exists:', !!apiKey, 'value:', apiKey?.slice(0, 10));
      if (!apiKey) {
        throw new Error("Clé API не найдена. Пожалуйста, проверьте настройки (Secrets) в AI Studio.");
      }

      const ai = new GoogleGenAI({ apiKey });
      console.log('[DEBUG] Sending request to Gemini...');
      const response = await ai.models.generateContent({
        model: "gemma-4-26b-a4b-it",
        contents: `Translate the word or phrase "${trimmedQuery}" between French and ${currentLangObj.aiName}.
        If it's French, translate to ${currentLangObj.aiName}. If it's ${currentLangObj.aiName}, translate to French.

        Return ONLY a compact JSON object with these fields (no explanations, no alternatives, just the best single translation):
        - "frenchWord": French word with article if noun (e.g. "le chat")
        - "translation": ONE short translation in ${currentLangObj.aiName}, max 3 words
        - "gender": "m", "f", or "none"
        - "isPlural": boolean
        - "infinitive": French infinitive if verb, else ""
        - "infinitiveTranslation": translation of infinitive in ${currentLangObj.aiName}, else ""
        - "example": one short French sentence (max 10 words)
        - "exampleTranslation": translation of example in ${currentLangObj.aiName}
        - "found": true if valid word found
        - "suggestions": [] or array of related French words if not found`,
        config: {
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              found: { type: Type.BOOLEAN },
              frenchWord: { type: Type.STRING },
              translation: { type: Type.STRING },
              gender: { type: Type.STRING },
              isPlural: { type: Type.BOOLEAN },
              infinitive: { type: Type.STRING },
              infinitiveTranslation: { type: Type.STRING },
              example: { type: Type.STRING },
              exampleTranslation: { type: Type.STRING },
              suggestions: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ["found"]
          }
        }
      });

      const parts = response?.candidates?.[0]?.content?.parts;
      console.log('[DEBUG] parts count:', parts?.length, 'part keys:', parts?.[0] ? Object.keys(parts[0]) : 'none');
      console.log('[DEBUG] Response received:', extractJson(response)?.slice(0, 200));
      const result = JSON.parse(extractJson(response) || '{}');

      if (result.found && result.frenchWord && result.translation) {
        const finalWord = result.frenchWord;
        const normalizedFinal = normalizeWord(finalWord);
        
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
          next_review_at: Date.now() + (1000 * 60 * 60 * 24),
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
      } else if (!result.found && result.suggestions) {
        setSuggestions(result.suggestions);
        setError(`Le mot "${trimmedQuery}" n'a pas été trouvé. Vouliez-vous dire :`);
      }
    } catch (err: any) {
      console.error("Translation error:", err);
      setError(`Erreur: ${err.message || 'Erreur inconnue'}`);
    } finally {
      clearTimeout(timeoutId);
      setIsSearching(false);
    }
  }, [targetLanguage, currentLangObj.aiName, words, normalizeWord]);

  // Debounce search
  useEffect(() => {
    if (!searchQuery) {
      lastFetchedQuery.current = '';
      setIsSearching(false);
      return;
    }

    if (searchResult) {
      setIsSearching(false);
      return;
    }

    const timer = setTimeout(() => {
      fetchTranslation(searchQuery);
    }, 1200);

    return () => clearTimeout(timer);
  }, [searchQuery, searchResult, fetchTranslation]);

  // Auto-start review if words are due, or refresh if language changes
  useEffect(() => {
    if (reviewQueue.length > 0 && !isReviewing) {
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
  }, [reviewQueue, isReviewing, targetLanguage, sessionQueue.length]);

  const handleReview = (grade: ReviewGrade) => {
    if (!currentWord || !isReviewing) return;

    const updatedWords = words.map(w => {
      if (w.id === currentWord.id) {
        let nextReview = Date.now();
        let status = w.status;
        let reviewCount = w.review_count;

        if (grade === 'remembered') {
          // Follow the 1-3-7-14-30 days scheme
          // review_count 0 -> just did 1st review, next is in 3 days
          // review_count 1 -> just did 2nd review, next is in 7 days
          // ...
          // review_count 4 -> just did 5th review, mastered
          
          if (reviewCount < REVIEW_INTERVALS.length - 1) {
            const nextIntervalDays = REVIEW_INTERVALS[reviewCount + 1];
            nextReview += 1000 * 60 * 60 * 24 * nextIntervalDays;
            status = 'learning';
          } else {
            status = 'mastered';
          }
          reviewCount += 1;
        } else if (grade === 'almost') {
          // Stay on current level but review tomorrow
          nextReview += 1000 * 60 * 60 * 24 * 1;
          status = 'learning';
          // Optional: decrease reviewCount to repeat the interval
          reviewCount = Math.max(0, reviewCount - 1);
        } else {
          // Forgotten: review in 1 hour and restart progress
          nextReview += 1000 * 60 * 60 * 1;
          status = 'learning';
          reviewCount = 0;
        }

        const isNowMastered = status === 'mastered' && w.status !== 'mastered';
        if (isNowMastered) {
          setJustMastered(w.word);
          setTimeout(() => setJustMastered(null), 3000);
        }

        return { ...w, next_review_at: nextReview, status, review_count: reviewCount, last_reviewed_at: Date.now() };
      }
      return w;
    });

    setWords(updatedWords);
    setShowTranslation(false);
    
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
      const response = await ai.models.generateContent({
        model: "gemma-4-26b-a4b-it",
        contents: `Extract French vocabulary from the following text: ${text.substring(0, 5000)}.
        Identify word, translation in ${targetLanguage}, gender (m/f/none), isPlural, infinitive, and examples.
        Respond ONLY with a JSON array of objects. No reasoning allowed.`,
        config: {
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                word: { type: Type.STRING },
                translation: { type: Type.STRING },
                gender: { type: Type.STRING },
                isPlural: { type: Type.BOOLEAN },
                infinitive: { type: Type.STRING },
                infinitiveTranslation: { type: Type.STRING },
                example: { type: Type.STRING },
                exampleTranslation: { type: Type.STRING }
              },
              required: ["word", "translation"]
            }
          }
        }
      });

      const result = JSON.parse(extractJson(response) || '[]');
      if (Array.isArray(result) && result.length > 0) {
        const newWords: Word[] = result.map(item => ({
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
          next_review_at: Date.now() + (1000 * 60 * 60 * 24), // First review in 1 day
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
    if (!file) return;

    const fileType = file.name.split('.').pop()?.toLowerCase();
    let extractedText = "";

    try {
      if (fileType === 'xlsx' || fileType === 'xls') {
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data);
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        extractedText = XLSX.utils.sheet_to_txt(firstSheet);
      } else if (fileType === 'docx') {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        extractedText = result.value;
      } else if (fileType === 'pdf') {
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
                <span className="text-indigo-600">{dailyStats.reviewedToday} / {dailyStats.totalToday}</span>
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
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* Left Section: Flashcards */}
          <section id="flashcards-section" className="order-2 lg:order-1 lg:col-span-7 space-y-6">
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
                    onClick={stopReview}
                    className="px-3 py-1.5 bg-slate-100 text-slate-600 rounded-lg text-xs font-bold uppercase tracking-tight hover:bg-slate-200 transition-colors"
                  >
                    Arrêter
                  </button>
                </div>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded-3xl p-8 min-h-[400px] flex flex-col items-center justify-center relative overflow-hidden shadow-sm">
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
                      <span className="px-3 py-1 bg-indigo-50 text-indigo-600 text-[10px] font-bold uppercase tracking-widest rounded-full">
                        Mot {currentReviewIndex + 1} sur {sessionQueue.length}
                      </span>
                        <div className="flex items-center justify-center gap-4">
                          <h3 className="text-3xl sm:text-4xl md:text-5xl font-black text-slate-900 tracking-tight break-words">
                            {getWordWithArticle(currentWord?.word || '', currentWord?.gender, currentWord?.isPlural)}
                          </h3>
                          <div className="flex flex-col gap-2">
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
                            <div className="flex flex-col gap-1">
                              {currentWord?.gender && currentWord.gender !== 'none' && (
                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase text-center ${
                                  currentWord.gender === 'm' ? 'bg-blue-100 text-blue-600' : 'bg-pink-100 text-pink-600'
                                }`}>
                                  {currentWord.gender === 'm' ? 'masc' : 'fém'}
                                </span>
                              )}
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase text-center ${
                                currentWord?.status === 'mastered' ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'
                              }`}>
                                {currentWord?.status === 'mastered' ? 'Appris' : 'En cours'}
                              </span>
                            </div>
                          </div>
                        </div>
                      {currentWord?.example && (
                        <div className="space-y-1">
                          <p className="text-slate-500 italic text-base sm:text-lg max-w-md">"{cleanExample(currentWord.example)}"</p>
                          {currentWord?.infinitive && (
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
                        onClick={() => setShowTranslation(true)}
                        className={`p-6 border-2 border-dashed rounded-2xl text-center cursor-pointer transition-all ${
                          showTranslation 
                            ? 'border-indigo-200 bg-indigo-50/30' 
                            : 'border-slate-200 hover:border-indigo-300 bg-slate-50/50'
                        }`}
                      >
                        {showTranslation ? (
                          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                            <p className="text-xs text-indigo-400 uppercase font-bold tracking-widest mb-1">Traduction</p>
                            <p className="text-xl sm:text-2xl font-bold text-indigo-600">{currentWord?.translation}</p>
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
                          <p className="text-slate-400 font-medium">Cliquez pour voir la traduction</p>
                        )}
                      </div>

                      {showTranslation && (
                        <motion.div 
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="grid grid-cols-3 gap-3"
                        >
                          <button 
                            onClick={() => handleReview('forgotten')}
                            className="flex flex-col items-center gap-2 p-3 rounded-xl border border-red-100 hover:bg-red-50 transition-colors group"
                          >
                            <XCircle className="text-red-400 group-hover:text-red-500" size={24} />
                            <span className="text-[10px] font-bold uppercase text-red-500">Oublié</span>
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
                            <span className="text-[10px] font-bold uppercase text-emerald-600">Retenu</span>
                          </button>
                        </motion.div>
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
          </section>

          {/* Right Section: Dictionary */}
          <section id="dictionary-section" className="order-1 lg:order-2 lg:col-span-5 space-y-6">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Search size={18} className="text-indigo-600" />
              Dictionnaire Intelligent
            </h2>

            <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm space-y-6">
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
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-24 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all font-medium"
                  />
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  
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
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-bold uppercase text-indigo-400 tracking-widest leading-none mb-1">Français</p>
                        <div className="flex items-center gap-1.5 sm:gap-3 overflow-hidden">
                          <h4 className="text-xl sm:text-2xl font-bold text-slate-900 truncate shrink min-w-0">
                            {getWordWithArticle(searchResult.word, searchResult.gender, searchResult.isPlural)}
                          </h4>
                          <button 
                            onClick={() => speak(searchResult.word)}
                            className="p-1 px-1.5 bg-indigo-50 text-indigo-600 rounded-lg hover:bg-indigo-100 transition-colors shrink-0"
                            title="Écouter"
                          >
                            <Volume2 size={16} />
                          </button>
                          {searchResult.gender && searchResult.gender !== 'none' && (
                            <span className={`px-1 py-0.5 rounded text-[8px] sm:text-[9px] font-bold uppercase shrink-0 ${
                              searchResult.gender === 'm' ? 'bg-blue-100 text-blue-600' : 'bg-pink-100 text-pink-600'
                            }`}>
                              {searchResult.gender === 'm' ? 'm' : 'f'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
                        <button 
                          onClick={() => {
                            setWordListSearchQuery(searchResult.word);
                            setIsWordListModalOpen(true);
                          }}
                          className="px-1.5 py-1 bg-white border border-indigo-100 rounded-lg text-[9px] font-bold text-indigo-600 uppercase hover:bg-indigo-50 transition-colors whitespace-nowrap"
                        >
                          En base
                        </button>
                        <button 
                          onClick={() => setEditingWord(searchResult)}
                          className="p-1.5 text-slate-300 hover:text-indigo-500 hover:bg-indigo-50 rounded-lg transition-all border border-transparent hover:border-indigo-100"
                          title="Modifier"
                        >
                          <Edit2 size={16} />
                        </button>
                        <button 
                          onClick={(e) => handleDeleteWord(searchResult.id, e)}
                          className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all border border-transparent hover:border-red-100"
                          title="Supprimer du dictionnaire"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                    <div>
                        <p className="text-[10px] font-bold uppercase text-indigo-400 tracking-widest">{currentLangObj.name}</p>
                        <p className="text-lg font-semibold text-indigo-600">{searchResult.translation}</p>
                      {searchResult.infinitive && (
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
                        <p className="text-sm text-slate-600 italic leading-relaxed">
                          {cleanExample(searchResult.example)}
                        </p>
                        {getExampleTranslation(searchResult) && (
                          <p className="text-[10px] text-slate-400 italic mt-1">
                            ({getExampleTranslation(searchResult)})
                          </p>
                        )}
                      </div>
                    )}
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
                  <div className="text-center py-12 space-y-3 opacity-40">
                    <Search size={32} className="mx-auto text-slate-300" />
                    <p className="text-sm font-medium text-slate-500">Entrez un mot pour le traduire et l'ajouter automatiquement à votre base.</p>
                  </div>
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
                    
                    if (searchResult && searchResult.id === idToRemove) {
                      setSearchQuery('');
                    }

                    // Handle review session if active
                    if (isReviewing && currentWord && currentWord.id === idToRemove) {
                      setShowTranslation(false);
                      if (currentReviewIndex + 1 < sessionQueue.length) {
                        setCurrentReviewIndex(prev => prev + 1);
                      } else {
                        stopReview();
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
                    <h3 className="text-xl font-bold text-slate-900">Histoires et Lacunes</h3>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Entraînez-vous avec votre vocabulaire</p>
                  </div>
                </div>
                <button 
                  onClick={() => setIsTextExerciseModalOpen(false)}
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
                        Je vais générer une courte histoire en utilisant les mots de votre bibliothèque. À vous de remplir les blancs !
                      </p>
                    </div>
                    <button 
                      onClick={generateStoryExercise}
                      className="px-8 py-4 bg-indigo-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 flex items-center gap-2 mx-auto"
                    >
                      <Sparkles size={18} />
                      Générer l'histoire
                    </button>
                  </div>
                )}

                {isStoryLoading && (
                  <div className="text-center py-20">
                    <div className="relative w-16 h-16 mx-auto mb-6">
                      <div className="absolute inset-0 border-4 border-indigo-100 rounded-full"></div>
                      <div className="absolute inset-0 border-4 border-indigo-600 rounded-full border-t-transparent animate-spin"></div>
                    </div>
                    <p className="text-slate-500 font-medium animate-pulse">Inspiration en cours...</p>
                  </div>
                )}

                {generatedStory && !isStoryLoading && (
                  <div className="space-y-8">
                    <div className="text-center">
                      <h4 className="text-2xl font-serif font-bold text-slate-900 mb-2 italic">
                        {generatedStory.title}
                      </h4>
                      <div className="h-1 w-12 bg-indigo-100 mx-auto rounded-full"></div>
                    </div>

                    <div className="p-6 bg-slate-50 rounded-3xl text-lg leading-relaxed text-slate-700 font-medium whitespace-pre-wrap">
                      {generatedStory.story.split(/(\{\{\d+\}\})/).map((part, index) => {
                        const match = part.match(/\{\{(\d+)\}\}/);
                        if (match) {
                          const gapIndex = parseInt(match[1]);
                          return (
                            <button
                              key={index}
                              onClick={() => {
                                if (exerciseFeedback === 'success') return;
                                
                                if (userAnswers[gapIndex]) {
                                  // Clear word
                                  const newAnswers = [...userAnswers];
                                  newAnswers[gapIndex] = '';
                                  setUserAnswers(newAnswers);
                                  setExerciseFeedback(null);
                                  setSelectedGapIndex(gapIndex);
                                } else {
                                  // Select empty gap
                                  setSelectedGapIndex(gapIndex === selectedGapIndex ? null : gapIndex);
                                }
                              }}
                              className={`mx-1 px-3 py-1 rounded-lg border-2 transition-all inline-flex items-center justify-center min-w-[80px] h-9 align-middle cursor-pointer group hover:scale-105 active:scale-95 ${
                                userAnswers[gapIndex] 
                                  ? 'bg-indigo-50 border-indigo-200 text-indigo-700 font-bold' 
                                  : 'bg-white border-dashed border-slate-300'
                              } ${selectedGapIndex === gapIndex ? 'ring-2 ring-indigo-500 ring-offset-2 border-indigo-500' : ''} 
                                ${exerciseFeedback === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700 pointer-events-none' : ''}
                                ${exerciseFeedback === 'error' && userAnswers[gapIndex] !== generatedStory.gaps[gapIndex] ? 'bg-red-50 border-red-200 text-red-700 ring-red-500/20' : ''}`}
                            >
                              {userAnswers[gapIndex] || (
                                <span className="text-slate-300 text-xs font-bold opacity-0 group-hover:opacity-100 transition-opacity">
                                  {gapIndex + 1}
                                </span>
                              )}
                            </button>
                          );
                        }
                        return <span key={index}>{part}</span>;
                      })}
                    </div>

                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Banque de mots</span>
                        <button 
                          onClick={() => setUserAnswers(new Array(generatedStory.gaps.length).fill(''))}
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

                          // Find the translation for this word
                          const wordObj = words.find(w => 
                            w.word.toLowerCase() === word.toLowerCase() || 
                            (w.french_word && w.french_word.toLowerCase() === word.toLowerCase())
                          );

                          return (
                            <div key={index} className="relative group">
                              <button
                                disabled={isUsed || exerciseFeedback === 'success'}
                                onClick={() => {
                                  if (isShowingHint) {
                                    setWordHintIndex(null);
                                    return;
                                  }
                                  const newAnswers = [...userAnswers];
                                  const targetIndex = selectedGapIndex !== null && userAnswers[selectedGapIndex] === '' 
                                    ? selectedGapIndex 
                                    : userAnswers.indexOf('');

                                  if (targetIndex !== -1) {
                                    newAnswers[targetIndex] = word;
                                    setUserAnswers(newAnswers);
                                    setExerciseFeedback(null);
                                    
                                    // Clear selection if we fulfilled it
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
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setWordHintIndex(isShowingHint ? null : index);
                                  }}
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
                    </div>

                    <div className="pt-6 border-t border-slate-100 flex items-center justify-between gap-4">
                      <button 
                        onClick={generateStoryExercise}
                        className="p-3 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all"
                        title="Nouvelle histoire"
                      >
                        <RefreshCw size={20} />
                      </button>
                      
                      <button 
                        disabled={userAnswers.includes('') || exerciseFeedback === 'success'}
                        onClick={() => {
                          const isCorrect = userAnswers.every((ans, i) => ans === generatedStory.gaps[i]);
                          setExerciseFeedback(isCorrect ? 'success' : 'error');
                        }}
                        className={`flex-1 py-4 rounded-2xl font-bold text-sm uppercase tracking-widest transition-all shadow-lg ${
                          userAnswers.includes('') 
                            ? 'bg-slate-100 text-slate-400 shadow-none' 
                            : exerciseFeedback === 'success'
                              ? 'bg-emerald-500 text-white shadow-emerald-100'
                              : 'bg-indigo-600 text-white shadow-indigo-100 hover:bg-indigo-700 active:scale-[0.98]'
                        }`}
                      >
                        {exerciseFeedback === 'success' ? 'Parfait !' : 'Vérifier'}
                      </button>
                    </div>

                    {exerciseFeedback === 'error' && (
                      <motion.p 
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="text-center text-sm font-bold text-red-500 flex items-center justify-center gap-2"
                      >
                        <AlertCircle size={16} />
                        Certains mots ne sont pas à la bonne place.
                      </motion.p>
                    )}
                  </div>
                )}
              </div>
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
                  onClick={() => setIsMatchModalOpen(false)}
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
                    className="text-center pt-4"
                  >
                    <button
                      onClick={startMatchGame}
                      className="px-8 py-4 bg-emerald-500 text-white rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-emerald-600 transition-all shadow-lg shadow-emerald-100 flex items-center gap-2 mx-auto"
                    >
                      <RotateCcw size={18} />
                      Rejouer
                    </button>
                  </motion.div>
                )}
              </div>
            </motion.div>
          </div>
        )}
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

          {/* Central Icons */}
          <div className="flex items-center gap-4">
            <button 
              onClick={startMatchGame}
              className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center hover:bg-indigo-100 transition-all border-2 border-indigo-100 shadow-sm active:scale-95"
              title="Relier les mots"
            >
              <Grid2X2 size={24} />
            </button>
            <button 
              onClick={() => setIsTextExerciseModalOpen(true)}
              className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center hover:bg-indigo-100 transition-all border-2 border-indigo-100 shadow-sm active:scale-95"
              title="Exercice de texte"
            >
              <FileText size={24} />
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
