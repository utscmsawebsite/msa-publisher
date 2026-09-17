export interface JummahDraft {
  firstStartTime: string;
  firstEndTime: string;
  firstLocation: string;
  secondStartTime: string | null;
  secondEndTime: string | null;
  secondLocation: string | null;
  updatedBySlackUserId: string;
}

export interface JummahContent extends JummahDraft {
  id: "current";
  isOffered: boolean;
  unavailableMessage: string | null;
  updatedAt: string;
}

export interface JummahUnavailableDraft {
  unavailableMessage: string;
  updatedBySlackUserId: string;
}

export type PublicJummah = Omit<JummahContent, "updatedBySlackUserId">;
