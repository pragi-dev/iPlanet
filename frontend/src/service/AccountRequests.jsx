import { useState } from 'react';
import { UserCheck, UserX } from 'lucide-react';
import { approveAccountRequest, getAccountRequests, getCompanies, rejectAccountRequest } from './api';
import { Badge, Button, Card, EmptyState, ErrorState, InlineAlert, Skeleton, formatDateTime, friendlyError, useAsync } from '../ui';

// Pending Corporate Self-Care sign-ups. Approving one creates a corporate admin for the
// organization chosen here — never the organization the requester typed — so a requester
// can't attach themselves to another company.
export function AccountRequests() {
  const requests = useAsync(() => getAccountRequests('pending'), []);
  const companies = useAsync(getCompanies, []);
  const [choice, setChoice] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const companyList = companies.data || [];
  const suggestion = request => companyList.find(company => company.name.trim().toLowerCase() === request.organization.trim().toLowerCase())?._id || '';
  const remove = id => requests.setData(current => (current || []).filter(item => item.id !== id));

  const act = async (request, action) => {
    setBusy(`${action}:${request.id}`);
    setError('');
    setDone('');
    try {
      if (action === 'approve') {
        const companyId = choice[request.id] ?? suggestion(request);
        await approveAccountRequest(request.id, companyId);
        setDone(`${request.name} can now sign in to Corporate Self-Care.`);
      } else {
        await rejectAccountRequest(request.id);
        setDone(`The request from ${request.name} was rejected.`);
      }
      remove(request.id);
    } catch (actionError) {
      setError(friendlyError(actionError, 'The request could not be updated. Please try again.'));
    } finally {
      setBusy('');
    }
  };

  const items = requests.data || [];
  return <Card title="Account requests" description="Corporate Self-Care sign-ups waiting for approval. Approve only people you have confirmed belong to the organization." actions={items.length ? <Badge tone="info">{items.length} pending</Badge> : null}>
    {done && <InlineAlert tone="success">{done}</InlineAlert>}
    {error && <InlineAlert title="Not updated">{error}</InlineAlert>}
    {requests.loading ? <div className="stack-16"><Skeleton width="60%" /><Skeleton width="40%" /></div>
      : requests.error ? <ErrorState compact title="Unable to load account requests" message={friendlyError(requests.error)} onRetry={() => requests.reload()} />
        : !items.length ? <EmptyState compact icon={UserCheck} title="No pending requests" description="New sign-ups from the Corporate Self-Care sign-up page appear here." />
          : <ul className="account-requests">
            {items.map(request => {
              const companyId = choice[request.id] ?? suggestion(request);
              return <li key={request.id} className="account-request">
                <div className="account-request-who">
                  <strong>{request.name}</strong>
                  <span className="cell-sub">{request.email}{request.phone ? ` · ${request.phone}` : ''}</span>
                  <span className="cell-sub">Says they work at <strong>{request.organization}</strong>{request.gstNumber ? ` · GSTIN ${request.gstNumber}` : ''} · requested {formatDateTime(request.createdAt)}</span>
                </div>
                <div className="account-request-actions">
                  <select className="select" aria-label={`Organization for ${request.name}`} value={companyId} onChange={event => setChoice(current => ({ ...current, [request.id]: event.target.value }))} disabled={companies.loading}>
                    <option value="">{companies.loading ? 'Loading organizations…' : 'Select organization'}</option>
                    {companyList.map(company => <option key={company._id} value={company._id}>{company.name}</option>)}
                  </select>
                  <Button variant="primary" size="sm" icon={UserCheck} disabled={!companyId || Boolean(busy)} onClick={() => act(request, 'approve')}>{busy === `approve:${request.id}` ? 'Approving…' : 'Approve'}</Button>
                  <Button size="sm" icon={UserX} disabled={Boolean(busy)} onClick={() => act(request, 'reject')}>{busy === `reject:${request.id}` ? 'Rejecting…' : 'Reject'}</Button>
                </div>
              </li>;
            })}
          </ul>}
  </Card>;
}
