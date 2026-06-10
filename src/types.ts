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
}

export type ReviewGrade = 'remembered' | 'almost' | 'forgotten';
