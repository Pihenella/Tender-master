export interface Task {
  _id: string;
  status: string;
  number: string;
  name: string;
  processingMode?: string;
  profileId: string;
  [key: string]: any;
}

export interface ProcurementData {
  procurement: any;
  files: Array<{ _id: string; storageId: string; fileName: string; fileType: string; url: string }>;
  calcData: any[];
  forms: Array<{ _id: string; name: string; fileName: string; fileType: string; url: string }>;
}

export class ConvexClient {
  constructor(
    private baseUrl: string,
    private secret: string,
  ) {}

  private async request(path: string, method: string = "POST", body?: any): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.secret}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Convex HTTP ${res.status}: ${text}`);
    }
    return res.json();
  }

  async getPendingTasks(): Promise<Task[]> {
    return this.request("/api/local/pending-tasks", "GET");
  }

  async getProcurementData(id: string): Promise<ProcurementData> {
    return this.request("/api/local/get-procurement", "POST", { id });
  }

  async updateStatus(id: string, status: string, statusMessage?: string, progress?: number): Promise<void> {
    await this.request("/api/local/update-status", "POST", { id, status, statusMessage, progress });
  }

  async saveAnalysisResult(procurementId: string, data: any): Promise<void> {
    await this.request("/api/local/save-analysis", "POST", { procurementId, ...data });
  }

  async triggerSlice(procurementId: string, forms: any[]): Promise<void> {
    await this.request("/api/local/trigger-slice", "POST", { procurementId, forms });
  }

  async triggerCalc(procurementId: string): Promise<void> {
    await this.request("/api/local/trigger-calc", "POST", { procurementId });
  }

  async saveFillResult(procurementId: string, fillResults: any[]): Promise<void> {
    await this.request("/api/local/save-fill", "POST", { procurementId, fillResults });
  }

  async downloadFile(url: string, outputPath: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const fs = await import("fs/promises");
    await fs.writeFile(outputPath, buffer);
  }
}
