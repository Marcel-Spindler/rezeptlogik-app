import { useCallback, useEffect, useState } from "react";
import { collection, doc, getFirebase, getFirebaseAuth, onSnapshot, serverTimestamp, setDoc } from "../../core/firebase";
import { usePersistent } from "../../lib/helpers";
import type { OperationsTaskState, OperationsTaskStatus } from "./operationsTasks";

const COLLECTION = ["apps", "rezeptlogik", "operationsTasks"] as const;
const VALID_STATUSES = new Set<OperationsTaskStatus>(["open", "in-progress", "done"]);

function readTaskState(value: unknown): OperationsTaskState | null {
  if (!value || typeof value !== "object") return null;
  const item = value as { status?: unknown; owner?: unknown; changedAt?: unknown };
  if (typeof item.status !== "string" || !VALID_STATUSES.has(item.status as OperationsTaskStatus)) return null;
  return {
    status: item.status as OperationsTaskStatus,
    owner: typeof item.owner === "string" ? item.owner : "",
    changedAt: typeof item.changedAt === "number" && Number.isFinite(item.changedAt) ? item.changedAt : undefined,
  };
}

export function useOperationsTaskState() {
  const hasFirebase = Boolean(import.meta.env.VITE_FIREBASE_PROJECT_ID);
  const [localState, setLocalState] = usePersistent<Record<string, OperationsTaskState>>("operations_task_state", {});
  const [remoteState, setRemoteState] = useState<Record<string, OperationsTaskState>>({});
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasFirebase) return;
    try {
      const { db } = getFirebase();
      return onSnapshot(collection(db, ...COLLECTION), (snapshot) => {
        const next: Record<string, OperationsTaskState> = {};
        for (const entry of snapshot.docs) {
          const state = readTaskState(entry.data());
          if (state) next[entry.id] = state;
        }
        setRemoteState(next);
        setSyncError(null);
      }, (reason) => setSyncError(reason.message));
    } catch (reason) {
      setSyncError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [hasFirebase]);

  const updateTask = useCallback(async (taskId: string, patch: Partial<OperationsTaskState>) => {
    const current = hasFirebase ? remoteState[taskId] : localState[taskId];
    const next: OperationsTaskState = {
      status: patch.status ?? current?.status ?? "open",
      owner: patch.owner ?? current?.owner ?? "",
      changedAt: Date.now(),
    };
    if (!hasFirebase) {
      setLocalState((state) => ({ ...state, [taskId]: next }));
      return;
    }

    setRemoteState((state) => ({ ...state, [taskId]: next }));
    try {
      const { db } = getFirebase();
      await setDoc(doc(db, ...COLLECTION, taskId), {
        ...next,
        updatedAt: serverTimestamp(),
        updatedBy: getFirebaseAuth().currentUser?.uid ?? "",
      }, { merge: true });
      setSyncError(null);
    } catch (reason) {
      setSyncError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [hasFirebase, localState, remoteState, setLocalState]);

  return {
    taskState: hasFirebase ? remoteState : localState,
    updateTask,
    syncError,
    teamSynced: hasFirebase,
  };
}