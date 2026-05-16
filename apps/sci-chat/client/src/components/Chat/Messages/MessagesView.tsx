import { useState, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { CSSTransition } from 'react-transition-group';
import type { TMessage } from 'librechat-data-provider';
import { useScreenshot, useMessageScrolling, useLocalize } from '~/hooks';
import ScrollToBottom from '~/components/Messages/ScrollToBottom';
import { MessagesViewProvider } from '~/Providers';
import { fontSizeAtom } from '~/store/fontSize';
import MultiMessage from './MultiMessage';
import MessageNav from './MessageNav';
import { cn } from '~/utils';
import store from '~/store';

function MessagesViewContent({
  messagesTree: _messagesTree,
  hiddenCount = 0,
  onShowAllMessages,
}: {
  messagesTree?: TMessage[] | null;
  hiddenCount?: number;
  onShowAllMessages?: () => void;
}) {
  const localize = useLocalize();
  const fontSize = useAtomValue(fontSizeAtom);
  const { screenshotTargetRef } = useScreenshot();
  const scrollButtonPreference = useRecoilValue(store.showScrollButton);
  const [currentEditId, setCurrentEditId] = useState<number | string | null>(-1);
  const scrollToBottomRef = useRef<HTMLDivElement>(null);

  const {
    conversation,
    scrollableRef,
    messagesEndRef,
    showScrollButton,
    handleSmoothToRef,
    debouncedHandleScroll,
  } = useMessageScrolling(_messagesTree);

  const { conversationId } = conversation ?? {};

  return (
    <>
      <div className="relative flex-1 overflow-hidden overflow-y-auto">
        <div className="relative h-full">
          <div
            className="scrollbar-gutter-stable"
            onScroll={debouncedHandleScroll}
            ref={scrollableRef}
            style={{
              height: '100%',
              overflowY: 'auto',
              width: '100%',
            }}
          >
            <div className="flex flex-col pb-9 pt-14 dark:bg-transparent">
              {hiddenCount > 0 && (
                <div className="flex items-center justify-center px-4 pb-2 pt-1">
                  <div className="flex items-center gap-3 rounded-lg border border-border-light bg-surface-secondary px-4 py-2 text-sm text-text-secondary">
                    <span>↑ {hiddenCount} earlier messages not shown</span>
                    <button
                      onClick={onShowAllMessages}
                      className="font-medium text-text-primary underline-offset-2 hover:underline"
                    >
                      Show all (slower)
                    </button>
                  </div>
                </div>
              )}
              {(_messagesTree && _messagesTree.length == 0) || _messagesTree === null ? (
                <div
                  className={cn(
                    'flex w-full items-center justify-center p-3 text-text-secondary',
                    fontSize,
                  )}
                >
                  {localize('com_ui_nothing_found')}
                </div>
              ) : (
                <>
                  <div ref={screenshotTargetRef}>
                    <MultiMessage
                      messagesTree={_messagesTree}
                      messageId={conversationId ?? null}
                      setCurrentEditId={setCurrentEditId}
                      currentEditId={currentEditId ?? null}
                    />
                  </div>
                </>
              )}
              <div
                id="messages-end"
                className="group h-0 w-full flex-shrink-0"
                ref={messagesEndRef}
              />
            </div>
          </div>

          <CSSTransition
            in={showScrollButton && scrollButtonPreference}
            timeout={{
              enter: 300,
              exit: 250,
            }}
            classNames="scroll-animation"
            unmountOnExit={true}
            appear={true}
            nodeRef={scrollToBottomRef}
          >
            <ScrollToBottom ref={scrollToBottomRef} scrollHandler={handleSmoothToRef} />
          </CSSTransition>

          <MessageNav scrollableRef={scrollableRef} />
        </div>
      </div>
    </>
  );
}

export default function MessagesView({
  messagesTree,
  hiddenCount,
  onShowAllMessages,
}: {
  messagesTree?: TMessage[] | null;
  hiddenCount?: number;
  onShowAllMessages?: () => void;
}) {
  return (
    <MessagesViewProvider>
      <MessagesViewContent
        messagesTree={messagesTree}
        hiddenCount={hiddenCount}
        onShowAllMessages={onShowAllMessages}
      />
    </MessagesViewProvider>
  );
}
