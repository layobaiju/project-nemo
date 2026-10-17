import type { Dispatch, SetStateAction } from 'react';
import type { Board, EventItem, Project } from './types.ts';
import type { WatchSummary } from './watch.ts';

export type View = 'Overview' | 'Graph' | 'World' | 'Map' | 'Explore' | 'Investigate' | 'Watchlist' | 'Folders' | 'Timeline' | 'Settings';
/** An entity opened from the Investigate page: Graph and World highlight it until cleared. Never saved. */
export type Focus = { label: string; nodeIds: string[]; recordIds: string[]; n: number };
export type Device = 'Windows' | 'macOS' | 'iPad';

/** Everything a view needs from the app shell. */
export type Ctx = {
  projects: Project[];
  project: Project;
  board: Board;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  patchBoard: (fn: (b: Board) => Board, boardId?: string) => void;
  /** Changes the current project's own settings (not its boards). */
  patchProject: (fn: (p: Project) => Project) => void;
  notify: (msg: string) => void;
  openRecord: (id: string, boardId?: string) => void;
  newRecord: (partial?: Partial<EventItem>) => void;
  openImport: () => void;
  setView: (v: View) => void;
  selectBoard: (id: string) => void;
  addBoard: (kind?: string, name?: string) => string;
  device: Device;
  readOnly: boolean;
  /** Open Explore and search public sources for this text. */
  searchWorld: (query: string) => void;
  pickMode: boolean;
  onPick: (lng: number, lat: number) => void;
  cancelPick: () => void;
  focus: Focus | null;
  setFocus: (f: Focus | null) => void;
  /** Watchlist badge and Watch buttons; refreshed every minute and after any watch action. */
  watch: WatchSummary;
  refreshWatch: () => void;
};
