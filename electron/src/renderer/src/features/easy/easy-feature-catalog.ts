import {
  BlocksIcon,
  BookOpenIcon,
  CaptionsIcon,
  FilmIcon,
  FingerprintIcon,
  FolderIcon,
  LayersIcon,
  LibraryIcon,
  MicVocalIcon,
  MessagesSquareIcon,
  Music2Icon,
  UsersRoundIcon,
  WandSparklesIcon,
  WorkflowIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react';
import { EASY_FEATURE_IDS, EASY_FEATURE_PATHS, type EasyFeatureId } from '@/lib/easy-features';

/** How each switchable original workspace looks in the easy screens. */
export interface EasyFeatureInfo {
  id: EasyFeatureId;
  path: (typeof EASY_FEATURE_PATHS)[EasyFeatureId];
  icon: LucideIcon;
  /** Plain name, e.g. `easy.feature_dub`. */
  nameKey: `easy.feature_${EasyFeatureId}`;
  /** One plain line on what it does, e.g. `easy.feature_dub_desc`. */
  descKey: `easy.feature_${EasyFeatureId}_desc`;
}

const ICONS: Record<EasyFeatureId, LucideIcon> = {
  clone: FingerprintIcon,
  design: WandSparklesIcon,
  personas: UsersRoundIcon,
  gallery: LibraryIcon,
  stories: MessagesSquareIcon,
  audiobook: BookOpenIcon,
  dub: FilmIcon,
  batch: LayersIcon,
  transcriptions: CaptionsIcon,
  calls: WorkflowIcon,
  projects: FolderIcon,
  tools: WrenchIcon,
  integrations: BlocksIcon,
  cover: Music2Icon,
  story_song: MicVocalIcon,
};

export const EASY_FEATURE_CATALOG: readonly EasyFeatureInfo[] = EASY_FEATURE_IDS.map((id) => ({
  id,
  path: EASY_FEATURE_PATHS[id],
  icon: ICONS[id],
  nameKey: `easy.feature_${id}` as const,
  descKey: `easy.feature_${id}_desc` as const,
}));

export function easyFeatureInfo(id: EasyFeatureId): EasyFeatureInfo {
  return EASY_FEATURE_CATALOG.find((item) => item.id === id)!;
}
