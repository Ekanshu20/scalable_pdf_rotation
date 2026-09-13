import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppShell } from '@/components/layout/app-shell';
import { ThemeProvider } from '@/components/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiError, getToken } from '@/lib/api';
import { FolderDetailPage } from '@/routes/folder-detail';
import { FoldersPage } from '@/routes/folders';
import { HistoryPage } from '@/routes/history';
import { ReviewPage } from '@/routes/review';
import { UploadPage } from '@/routes/upload';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // 401 already redirects to the login page; retrying it just delays that.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

export function App() {
  if (!getToken()) {
    window.location.href = '/';
    return null;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delayDuration={300}>
          <Router basename="/dashboard">
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<UploadPage />} />
                <Route path="folders" element={<FoldersPage />} />
                <Route path="folders/:folderId" element={<FolderDetailPage />} />
                <Route path="history" element={<HistoryPage />} />
                <Route path="review/:taskId" element={<ReviewPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </Router>
          <Toaster position="bottom-right" richColors closeButton />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
