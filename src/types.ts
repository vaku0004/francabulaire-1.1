export interface Word {
  id: string;
  word: string;
  translation: string;
  target_lang?: string;
  example?: string;
  exampleTranslation?: string;
  gender?: 'm' | 'f' | 'none';
  isPlural?: boolean;
  infinitive?: string;
  infinitiveTranslation?: string;
  tags?: string;
  created_at: number;
  next_review_at: number;
  status: 'new' | 'learning' | 'mastered';
  review_count: number;
  last_reviewed_at?: number;
  first_reviewed_at?: number;
  last_grade?: ReviewGrade;
  /** Common phrases built around this word, cached so they load once and show instantly. */
  collocations?: { phrase: string; translation: string }[];
  /** CEFR difficulty of the word/phrase, A1 (easiest) → C2. Drives the order new cards are introduced. */
  cefr?: CefrLevel;
}

export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
export const CEFR_LEVELS: CefrLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

export type ReviewGrade = 'remembered' | 'almost' | 'forgotten';
