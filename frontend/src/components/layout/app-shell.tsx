import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { FolderOpen, History, LogOut, Monitor, Moon, Sun, UploadCloud } from 'lucide-react';
import { logout } from '@/lib/api';
import { useMe } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { useTheme } from '@/components/theme-provider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const NAV = [
  { to: '/', label: 'Upload', icon: UploadCloud, end: true },
  { to: '/folders', label: 'Folders', icon: FolderOpen, end: false },
  { to: '/history', label: 'History', icon: History, end: false },
];

const THEMES = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

export function AppShell() {
  const { data: me } = useMe();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const ThemeIcon = THEMES.find((t) => t.value === theme)?.icon ?? Monitor;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-card/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="flex shrink-0 items-center gap-2 font-semibold tracking-tight"
          >
            <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <UploadCloud className="size-4" />
            </span>
            <span className="hidden sm:inline">RotatePDF</span>
          </button>

          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                  )
                }
              >
                <Icon className="size-4" />
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="flex shrink-0 items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Theme">
                  <ThemeIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {THEMES.map(({ value, label, icon: Icon }) => (
                  <DropdownMenuItem key={value} onSelect={() => setTheme(value)}>
                    <Icon />
                    {label}
                    {theme === value ? <span className="ml-auto text-xs text-muted-foreground">Active</span> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Account">
                  <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {(me?.email ?? '?').charAt(0).toUpperCase()}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[14rem]">
                <DropdownMenuLabel className="truncate normal-case">{me?.email ?? 'Signed in'}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={logout}>
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
