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
  updatedAt: string;
}

export type PublicJummah = Omit<JummahContent, "updatedBySlackUserId">;
