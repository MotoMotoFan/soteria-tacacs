import { Link } from 'react-router-dom';
import { BookOpen, Braces, Github, LifeBuoy } from 'lucide-react';

const links = [
  { label: 'Docs', href: '/docs/', icon: BookOpen, external: true },
  { label: 'API', href: '/api-docs', icon: Braces, external: false },
  { label: 'GitHub', href: 'https://github.com/MotoMotoFan/soteria-tacacs', icon: Github, external: true },
  { label: 'Issues', href: 'https://github.com/MotoMotoFan/soteria-tacacs/issues', icon: LifeBuoy, external: true },
];

export default function Footer() {
  const linkCls = 'flex items-center gap-1.5 hover:text-soteria-accent transition-colors';
  return (
    <footer className="mt-auto pt-8 shrink-0">
      <div
        className="flex flex-col sm:flex-row items-center justify-between gap-2 border-t pt-3 text-xs"
        style={{ borderColor: 'var(--s-border)', color: 'var(--s-muted)' }}
      >
        <span className="text-center sm:text-left">
          Soteria TACACS+ Management &middot; &copy; {new Date().getFullYear()} Pathfinder Insights
        </span>
        <nav className="flex items-center flex-wrap justify-center gap-x-4 gap-y-1">
          {links.map(({ label, href, icon: Icon, external }) =>
            external ? (
              <a key={label} href={href} target="_blank" rel="noreferrer" className={linkCls}>
                <Icon className="w-3.5 h-3.5" /> {label}
              </a>
            ) : (
              <Link key={label} to={href} className={linkCls}>
                <Icon className="w-3.5 h-3.5" /> {label}
              </Link>
            )
          )}
        </nav>
      </div>
    </footer>
  );
}
