import { UserSearchDropdown } from './ConversationsUserSearch';

export function ConversationsDefault() {
  return (
    <>
      <UserSearchDropdown onItemSelected={(id) => console.log(id)} />
      <div>
        <h1>ConversationsDefault</h1>
      </div>
    </>
  );
}
