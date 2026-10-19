import { useEffect, useState } from "react";
import type { UpdateStatus } from "@shared/types";

export function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    void window.api.updateStatus().then(setStatus);
    return window.api.onUpdate(setStatus);
  }, []);
  return status;
}
