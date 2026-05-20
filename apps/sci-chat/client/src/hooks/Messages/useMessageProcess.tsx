import throttle from 'lodash/throttle';
import { Constants } from 'librechat-data-provider';
import { useEffect, useRef, useMemo } from 'react';
import type { TMessage } from 'librechat-data-provider';
import { getTextKey, TEXT_KEY_DIVIDER, logger } from '~/utils';
import { useMessagesViewContext } from '~/Providers';

export default function useMessageProcess({ message }: { message?: TMessage | null }) {
  const latestText = useRef<string | number>('');
  // Keep a ref so the effect always calls setLatestMessage with the freshest message
  // without needing `message` itself in the effect's dependency array
  const messageRef = useRef<TMessage | null | undefined>(message);
  messageRef.current = message;

  // Depend on children LENGTH (stable primitive) rather than the full `message` object
  // (buildTree creates new message objects on every token, which would re-run this memo
  // for every message in the conversation on every streaming update)
  const hasNoChildren = useMemo(
    () => (message?.children?.length ?? 0) === 0,
    [message?.children?.length],
  );

  const { conversation, setAbortScroll, setLatestMessage, isSubmitting } = useMessagesViewContext();

  // Compute a stable key from specific message fields rather than the whole object.
  // This prevents the effect below from firing for ALL N messages on every streaming token —
  // only the leaf message (whose text is growing) has a changing textKey.
  const textKey = useMemo(
    () => (message ? getTextKey(message, conversation?.conversationId) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [message?.messageId, message?.text, message?.content, message?.conversationId, conversation?.conversationId],
  );

  useEffect(() => {
    const convoId = conversation?.conversationId;
    if (convoId === Constants.NEW_CONVO) {
      return;
    }
    const msg = messageRef.current;
    if (!msg) {
      return;
    }
    if (!hasNoChildren) {
      return;
    }

    // Check for text/conversation change
    const logInfo = {
      textKey,
      'latestText.current': latestText.current,
      messageId: msg.messageId,
      convoId,
    };

    /* Extracted convoId from previous textKey (format: messageId|||length|||lastChars|||convoId) */
    let previousConvoId: string | null = null;
    if (
      latestText.current &&
      typeof latestText.current === 'string' &&
      latestText.current.length > 0
    ) {
      const parts = latestText.current.split(TEXT_KEY_DIVIDER);
      previousConvoId = parts[parts.length - 1] || null;
    }

    if (
      textKey !== latestText.current ||
      (convoId != null && previousConvoId != null && convoId !== previousConvoId)
    ) {
      logger.log('latest_message', '[useMessageProcess] Setting latest message; logInfo:', logInfo);
      latestText.current = textKey;
      setLatestMessage({ ...msg });
    } else {
      logger.log('latest_message', 'No change in latest message; logInfo', logInfo);
    }
  }, [hasNoChildren, textKey, setLatestMessage, conversation?.conversationId]);

  /** Use ref for isSubmitting to stabilize handleScroll across isSubmitting changes */
  const isSubmittingRef = useRef(isSubmitting);
  isSubmittingRef.current = isSubmitting;

  const handleScroll = useMemo(
    () =>
      throttle((event: unknown) => {
        logger.log(
          'message_scrolling',
          `useMessageProcess: setting abort scroll to ${isSubmittingRef.current}, handleScroll event`,
          event,
        );
        setAbortScroll(isSubmittingRef.current);
      }, 500),
    [setAbortScroll],
  );

  useEffect(() => () => handleScroll.cancel(), [handleScroll]);

  return {
    handleScroll,
    isSubmitting,
    conversation,
  };
}
