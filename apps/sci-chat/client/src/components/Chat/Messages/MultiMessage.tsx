import { memo, useEffect, useCallback } from 'react';
import { useRecoilState } from 'recoil';
import { isAssistantsEndpoint } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { TMessageProps } from '~/common';
import MessageContent from '~/components/Messages/MessageContent';
import MessageParts from './MessageParts';
import Message from './Message';
import store from '~/store';

// Bail if messagesTree contains the same message objects as before.
// Combined with the buildTree stabilizer in ChatView, this prevents hooks from
// running in branches of the conversation tree that haven't changed.
function areMultiMessagePropsEqual(prev: TMessageProps, next: TMessageProps): boolean {
  if (prev.messageId !== next.messageId) return false;
  if (prev.currentEditId !== next.currentEditId) return false;
  if (prev.messagesTree === next.messagesTree) return true;
  if (!prev.messagesTree || !next.messagesTree) return false;
  if (prev.messagesTree.length !== next.messagesTree.length) return false;
  // Element-by-element ref check (O(siblings) which is typically 1-2)
  return prev.messagesTree.every((m, i) => m === next.messagesTree![i]);
}

const MultiMessage = memo(function MultiMessage({
  // messageId is used recursively here
  messageId,
  messagesTree,
  currentEditId,
  setCurrentEditId,
}: TMessageProps) {
  const [siblingIdx, setSiblingIdx] = useRecoilState(store.messagesSiblingIdxFamily(messageId));

  const setSiblingIdxRev = useCallback(
    (value: number) => {
      setSiblingIdx((messagesTree?.length ?? 0) - value - 1);
    },
    [messagesTree?.length, setSiblingIdx],
  );

  useEffect(() => {
    // reset siblingIdx when the tree changes, mostly when a new message is submitting.
    setSiblingIdx(0);
  }, [messagesTree?.length, setSiblingIdx]);

  useEffect(() => {
    if (messagesTree?.length && siblingIdx >= messagesTree.length) {
      setSiblingIdx(0);
    }
  }, [siblingIdx, messagesTree?.length, setSiblingIdx]);

  if (!(messagesTree && messagesTree.length)) {
    return null;
  }

  const currentSiblingIdx = messagesTree.length - siblingIdx - 1;
  const message = messagesTree[currentSiblingIdx] as TMessage | undefined;

  if (!message) {
    return null;
  }

  /**
   * No explicit key — React uses positional reconciliation since MultiMessage
   * always renders exactly one child at this position.
   *
   * Both messageId and parentMessageId change during the SSE lifecycle
   * (client UUID → createdHandler ID → server ID), so neither can serve as a
   * stable key. Using either caused React to unmount/remount the entire subtree
   * on each SSE event, destroying memoized state and causing visible flickering.
   *
   * Without a key, React reuses the component instance and updates props in place.
   * The memo comparators on ContentRender/MessageRender handle field-level diffing,
   * and sibling switches work correctly because the message prop changes entirely.
   */
  const sharedProps = {
    message,
    currentEditId,
    setCurrentEditId,
    siblingIdx: currentSiblingIdx,
    siblingCount: messagesTree.length,
    setSiblingIdx: setSiblingIdxRev,
  };

  if (isAssistantsEndpoint(message.endpoint) && message.content) {
    return <MessageParts {...sharedProps} />;
  } else if (message.content) {
    return <MessageContent {...sharedProps} />;
  }

  return <Message {...sharedProps} />;
}, areMultiMessagePropsEqual);
MultiMessage.displayName = 'MultiMessage';

export default MultiMessage;
