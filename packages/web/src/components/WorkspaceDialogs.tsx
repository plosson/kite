/**
 * Creating, changing and deleting a workspace, and moving a kite without
 * dragging it.
 *
 * The description is required and its hint says why: an assistant reads it to
 * decide which new kites go here, so a workspace without one cannot be sorted
 * into on purpose.
 *
 * Delete lives inside the edit dialog and asks again, naming how many kites go
 * back to Inbox, because "delete" next to a folder reads like it takes the
 * contents with it, and here it never does.
 */

import { useEffect, useState } from 'react';
import { ApiError, endpoints, type WorkspaceSummary } from '../api.js';
import { Button, Dialog, Field, TextInput } from './primitives.js';

const DESCRIPTION_HINT = 'Your assistant reads this to decide which new kites go here.';

export function WorkspaceDialog({
  open,
  workspace,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Null to create a new one. */
  workspace: WorkspaceSummary | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: 'name' | 'description' | null; message: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Each opening starts from what is stored, not from what was typed last time.
  useEffect(() => {
    if (!open) return;
    setName(workspace?.name ?? '');
    setDescription(workspace?.description ?? '');
    setError(null);
    setConfirmingDelete(false);
  }, [open, workspace]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const input = { name: name.trim(), description: description.trim() };
      if (workspace) await endpoints.updateWorkspace(workspace.id, input);
      else await endpoints.createWorkspace(input);
      onSaved();
      onClose();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Could not save it.';
      const field =
        caught instanceof ApiError && caught.code === 'name_taken'
          ? 'name'
          : /description/i.test(message)
            ? 'description'
            : /name/i.test(message)
              ? 'name'
              : null;
      setError({ field, message });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!workspace) return;
    setBusy(true);
    try {
      await endpoints.deleteWorkspace(workspace.id);
      onSaved();
      onClose();
    } catch (caught) {
      setError({ field: null, message: caught instanceof Error ? caught.message : 'Could not delete it.' });
      setConfirmingDelete(false);
    } finally {
      setBusy(false);
    }
  }

  if (workspace && confirmingDelete) {
    const count = workspace.count;
    return (
      <Dialog
        open={open}
        onClose={() => setConfirmingDelete(false)}
        title={`Delete ${workspace.name}?`}
        description={`Its ${count} kite${count === 1 ? '' : 's'} move to Inbox. No kite is deleted.`}
        footer={
          <>
            <Button size="sm" onClick={() => setConfirmingDelete(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" tone="danger" busy={busy} onClick={() => void remove()}>
              Delete workspace
            </Button>
          </>
        }
      />
    );
  }

  const canSave = name.trim().length > 0 && description.trim().length > 0 && !busy;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={workspace ? 'Edit workspace' : 'New workspace'}
      footer={
        <>
          {workspace && (
            <Button
              size="sm"
              tone="ghost"
              className="mr-auto text-danger"
              onClick={() => setConfirmingDelete(true)}
              disabled={busy}
            >
              Delete
            </Button>
          )}
          <Button size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" tone="primary" busy={busy} disabled={!canSave} onClick={() => void save()}>
            {workspace ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) void save();
        }}
      >
        <Field label="Name" htmlFor="workspace-name">
          <TextInput
            id="workspace-name"
            value={name}
            maxLength={60}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
          {error?.field === 'name' && <p className="text-[12px] text-danger">{error.message}</p>}
        </Field>
        <Field label="Description" htmlFor="workspace-description">
          <textarea
            id="workspace-description"
            value={description}
            maxLength={500}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
            className="w-full resize-y rounded-[--radius] border border-line bg-surface px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-3 transition-colors duration-100 hover:border-ink-3 focus:border-accent"
          />
          <p className="text-[12px] text-ink-3">{DESCRIPTION_HINT}</p>
          {error?.field === 'description' && <p className="text-[12px] text-danger">{error.message}</p>}
        </Field>
        {error && error.field === null && <p className="text-[12px] text-danger">{error.message}</p>}
        {/* Enter in the name field submits. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** Moving a kite by choosing, for a phone or a keyboard where dragging does not work. */
export function MoveDialog({
  artifact,
  workspaces,
  onClose,
  onMove,
}: {
  artifact: { id: string; title: string; workspaceId?: string } | null;
  workspaces: WorkspaceSummary[];
  onClose: () => void;
  onMove: (artifactId: string, workspaceId: string) => void;
}) {
  const current = artifact?.workspaceId ?? 'inbox';
  return (
    <Dialog open={artifact !== null} onClose={onClose} title={`Move “${artifact?.title ?? ''}” to…`} width={360}>
      <ul className="flex flex-col">
        {workspaces.map((workspace) => (
          <li key={workspace.id}>
            <button
              type="button"
              disabled={workspace.id === current}
              onClick={() => {
                if (artifact) onMove(artifact.id, workspace.id);
                onClose();
              }}
              className="flex w-full items-center justify-between rounded-[--radius-sm] px-2 py-2 text-left text-[13px] text-ink transition-colors hover:bg-sunken disabled:cursor-default disabled:text-ink-3 disabled:hover:bg-transparent"
            >
              {workspace.name}
              {workspace.id === current && <span className="text-[11px]">Here now</span>}
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
