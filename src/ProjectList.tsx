import { useI18n } from './i18n';
import { memo, useMemo, useState } from 'react';
import { ChevronRight, Folder, FolderPlus, LoaderCircle, MessageSquare, Plus, RefreshCw, Search } from 'lucide-react';
import { projectKey, projectName } from '../shared/project-path';
import { activeRunStates, type Conversation } from '../shared/types';
import { HarnessIcon } from './BrandIcon';
import './project-list.css';

type ProjectGroup = { directory: string; conversations: Conversation[] };

export const ProjectList = memo(function ProjectList({ directories, conversations, directory, selectedId, disabled, onAdd, onSelect, onNewChat, onOpenChat, onSync }: {
  directories: string[];
  conversations: Conversation[];
  directory: string;
  selectedId: string | null;
  disabled: boolean;
  onAdd(): void;
  onSelect(directory: string): void;
  onNewChat(directory: string): void;
  onOpenChat(chat: Conversation): void;
  onSync(directory: string): void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const query = search.trim().toLowerCase();
  const activeProject = projectKey(directory);
  const groups = useMemo(() => {
    const result = new Map<string, ProjectGroup>();
    for (const directory of directories) result.set(projectKey(directory), { directory, conversations: [] });
    for (const chat of conversations) {
      const key = projectKey(chat.workspace);
      const group = result.get(key) ?? { directory: chat.workspace, conversations: [] };
      group.conversations.push(chat);
      result.set(key, group);
    }
    return result;
  }, [directories, conversations]);
  const visible = useMemo(() => [...groups].flatMap(([key, group]) => {
    const projectMatches = group.directory.toLowerCase().includes(query);
    const chats = projectMatches ? group.conversations : group.conversations.filter(chat => chat.title.toLowerCase().includes(query));
    return projectMatches || chats.length ? [{ key, group, chats }] : [];
  }), [groups, query]);
  function expand(key: string) {
    setCollapsed(old => {
      const next = new Set(old);
      next.delete(key);
      return next;
    });
  }
  return <>
    <label className="search project-search">
      <Search size={15}/>
      <input placeholder={t("搜索项目或对话")} value={search} onChange={event => setSearch(event.target.value)}/>
    </label>
    <div className="project-list-heading">
      <strong>{t("项目")}{" "}<span>{groups.size}</span></strong>
      <button className="icon-button" title={t("添加项目")} aria-label={t("添加项目")} disabled={disabled} onClick={onAdd}><FolderPlus size={17}/></button>
    </div>
    <div className="conversation-list project-list" aria-label={t("项目列表")}>
      {visible.map(({ key, group, chats }) => {
        const name = projectName(group.directory);
        const open = !!query || !collapsed.has(key);
        const active = !!directory && key === activeProject;
        return <section className="project-group" aria-label={name} key={key}>
          <div className="project-group-header" data-active={active}>
            <button className="project-group-toggle" aria-label={t("{0}项目 {1}", open ? t("收起") : t("展开"), name)} aria-expanded={open}
              disabled={!!query} onClick={() => {
                if (open) setCollapsed(old => new Set([...old, key]));
                else expand(key);
              }}><ChevronRight size={14}/></button>
            <button className="project-group-name" title={group.directory} aria-current={active ? 'location' : undefined} disabled={disabled} onClick={() => { expand(key); onSelect(group.directory); }}>
              <Folder size={16}/><span>{name}</span>
            </button>
            <span className="project-group-count" title={t("{0} 条对话", group.conversations.length)}>{group.conversations.length}</span>
            <button className="project-group-new" title={t("项目同步")} aria-label={t("设置 {0} 的项目同步", name)} disabled={disabled} onClick={() => onSync(group.directory)}><RefreshCw size={13}/></button>
            <button className="project-group-new" title={t("在此项目开启对话")} aria-label={t("在 {0} 中开启对话", name)} disabled={disabled}
              onClick={() => { expand(key); onNewChat(group.directory); }}><Plus size={15}/></button>
          </div>
          {open && <div className="project-conversations">
            {chats.map(chat => <button className={`conversation-row ${chat.id === selectedId ? 'selected' : ''}`} key={chat.id}
              disabled={disabled} aria-current={chat.id === selectedId ? 'true' : undefined} onClick={() => onOpenChat(chat)}>
              <MessageSquare size={14}/><span>{chat.title}</span>
              {activeRunStates.has(chat.state) ? <LoaderCircle className="spin" size={13}/> : <HarnessIcon h={chat.harness}/>}
            </button>)}
            {!chats.length && <p className="project-no-conversations">{t("还没有对话")}</p>}
          </div>}
        </section>;
      })}
      {!visible.length && <div className="empty-list project-list-empty">
        <Folder size={25}/>
        <p>{query ? t("没有匹配的项目或对话") : t("添加一个项目")}</p>
        {!query && <span>{t("按工作目录组织对话")}</span>}
      </div>}
      {!query && conversations.length > 0 && <section className="recent-conversations" aria-label={t("最近对话")}>
        <h2>{t("最近")}</h2>
        {conversations.slice(0, 6).map(chat => <button className={`recent-row ${chat.id === selectedId ? 'selected' : ''}`}
          title={`${chat.title} · ${projectName(chat.workspace)}`} key={chat.id} disabled={disabled} onClick={() => onOpenChat(chat)}>
          <span>{chat.title}</span>{activeRunStates.has(chat.state) && <LoaderCircle className="spin" size={13}/>}
        </button>)}
      </section>}
    </div>
  </>;
});
