export type UserRole = 'admin' | 'je' | 'supervisor' | 'lineman';

export interface User {
  id: number;
  username: string;
  fullName: string;
  role: UserRole;
  supervisorId: number | null;
  supervisorName: string | null;
  createdAt: string;
}

export interface AuthStatus {
  needsAdminSetup: boolean;
  envAdminConfigured: boolean;
}

export interface DatasetInfo {
  id: number;
  fileName: string;
  headers: string[];
  rowCount: number;
  uploadedByName: string;
  uploadedAt: string;
}

export interface DatasetRow {
  id: number;
  datasetId: number;
  rowIndex: number;
  data: Record<string, string>;
}

export interface RemarkItem {
  id: number;
  datasetId: number;
  rowId: number;
  userId: number | null;
  userName: string;
  userRole: UserRole;
  comment: string;
  createdAt: string;
  updatedAt: string;
}

export interface DatasetPayload {
  dataset: DatasetInfo | null;
  rows: DatasetRow[];
  remarksByRow: Record<string, RemarkItem[]>;
  totalVisibleRemarks?: number;
}

export const ROLE_META: Record<
  UserRole,
  {
    label: string;
    hindiLabel: string;
    permissionSummary: string;
    remarkVisibilityHint: string;
  }
> = {
  admin: {
    label: 'Admin',
    hindiLabel: 'एडमिन (Admin)',
    permissionSummary: 'Excel अपलोड, सारा डाटा, सभी रिमार्क, यूज़र प्रबंधन और डाउनलोड',
    remarkVisibilityHint: 'सभी यूज़र्स के रिमार्क दिखाई दे रहे हैं',
  },
  je: {
    label: 'JE',
    hindiLabel: 'जेई (JE)',
    permissionSummary: 'डाटा सर्च, रिमार्क लिखना और सभी यूज़र्स के रिमार्क देखना',
    remarkVisibilityHint: 'सभी यूज़र्स के रिमार्क दिखाई दे रहे हैं',
  },
  supervisor: {
    label: 'Supervisor',
    hindiLabel: 'सुपरवाइज़र (Supervisor)',
    permissionSummary: 'डाटा सर्च, रिमार्क लिखना और अपने लाइनमैन के रिमार्क देखना',
    remarkVisibilityHint: 'केवल आपके और आपसे जुड़े लाइनमैन के रिमार्क दिखाई दे रहे हैं',
  },
  lineman: {
    label: 'Lineman',
    hindiLabel: 'लाइनमैन (Lineman)',
    permissionSummary: 'डाटा सर्च और केवल अपना रिमार्क लिखना व देखना',
    remarkVisibilityHint: 'केवल आपके द्वारा लिखे गए रिमार्क दिखाई दे रहे हैं',
  },
};

export function formatHindiDateTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('hi-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
