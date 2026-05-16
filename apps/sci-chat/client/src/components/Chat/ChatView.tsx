import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { useForm } from 'react-hook-form';
import { Spinner } from '@librechat/client';
import { useParams } from 'react-router-dom';
import { Constants, buildTree } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { ChatFormValues } from '~/common';
import { ChatContext, AddedChatContext, ChatFormProvider, useFileMapContext } from '~/Providers';
import { MCPServerManagerProvider } from '~/Providers/MCPServerManagerContext';
import { useInspector } from '~/components/Sci';
import { useAddedResponse, useResumeOnLoad, useAdaptiveSSE, useChatHelpers } from '~/hooks';
import { useGlobalShortcuts } from '~/hooks/useGlobalShortcuts';
import ConversationStarters from './Input/ConversationStarters';
import { useGetMessagesByConvoId } from '~/data-provider';
import ShortcutHelpDialog from './ShortcutHelpDialog';
import MessagesView from './Messages/MessagesView';
import Presentation from './Presentation';
import ChatForm from './Input/ChatForm';
import Landing from './Landing';
import Header from './Header';
import Footer from './Footer';
import { cn } from '~/utils';
import store from '~/store';

function LoadingSpinner() {
  return (
    <div className="relative flex-1 overflow-hidden overflow-y-auto">
      <div className="relative flex h-full items-center justify-center">
        <Spinner className="text-text-primary" />
      </div>
    </div>
  );
}

function ChatView({ index = 0 }: { index?: number }) {
  const { conversationId } = useParams();
  const rootSubmission = useRecoilValue(store.submissionByIndex(index));
  const centerFormOnLanding = useRecoilValue(store.centerFormOnLanding);

  const methods = useForm<ChatFormValues>({
    defaultValues: { text: '' },
  });

  const fileMap = useFileMapContext();

  // How many recent messages to render. Beyond this the DOM cost grows O(N) per frame.
  // Users can expand via the banner that appears when messages are hidden.
  const MAX_RENDERED_MESSAGES = 40;
  const [showAllMessages, setShowAllMessages] = useState(false);
  // Reset window when navigating to a different conversation
  useEffect(() => {
    setShowAllMessages(false);
  }, [conversationId]);

  // Cache of stable message node refs keyed by messageId.
  // buildTree creates new objects for ALL messages on every React Query update.
  // The stabilizer below preserves refs for messages whose content hasn't changed,
  // which lets React.memo bail out on unchanged branches of the conversation tree.
  const treeNodeCache = useRef<Map<string, TMessage>>(new Map());
  const hiddenCountRef = useRef(0);
  useEffect(() => {
    treeNodeCache.current.clear();
  }, [conversationId]);

  const { data: messagesTree = null, isLoading } = useGetMessagesByConvoId(conversationId ?? '', {
    select: useCallback(
      (data: TMessage[]) => {
        // Windowing: only render the last MAX_RENDERED_MESSAGES to cap O(N) DOM cost.
        // Messages outside the window are still in React Query — just not in the DOM.
        const toRender =
          !showAllMessages && data.length > MAX_RENDERED_MESSAGES
            ? data.slice(-MAX_RENDERED_MESSAGES)
            : data;
        hiddenCountRef.current = data.length - toRender.length;

        const dataTree = buildTree({ messages: toRender, fileMap });
        if (!dataTree?.length) return dataTree?.length === 0 ? null : (dataTree ?? null);

        const cache = treeNodeCache.current;

        // Walk the tree bottom-up: if a node's content fields and children refs are all
        // unchanged, return the cached node ref so downstream React.memo checks pass.
        const stabilize = (nodes: TMessage[]): TMessage[] => {
          let anyChanged = false;
          const result = nodes.map((node) => {
            const stableChildren = node.children?.length
              ? stabilize(node.children as TMessage[])
              : node.children;

            const prev = cache.get(node.messageId);
            if (
              prev &&
              prev.text === node.text &&
              prev.content === node.content &&
              prev.error === node.error &&
              prev.unfinished === node.unfinished &&
              prev.siblingIndex === node.siblingIndex &&
              prev.children === stableChildren
            ) {
              return prev;
            }

            const stable: TMessage =
              stableChildren !== node.children
                ? { ...node, children: stableChildren }
                : { ...node };
            cache.set(node.messageId, stable);
            anyChanged = true;
            return stable;
          });

          return anyChanged ? result : nodes;
        };

        return stabilize(dataTree);
      },
      [fileMap, showAllMessages],
    ),
    enabled: !!fileMap,
  });

  const chatHelpers = useChatHelpers(index, conversationId);
  const addedChatHelpers = useAddedResponse();

  useAdaptiveSSE(rootSubmission, chatHelpers, false, index);

  // Auto-resume if navigating back to conversation with active job
  // Wait for messages to load before resuming to avoid race condition
  useResumeOnLoad(conversationId, chatHelpers.getMessages, index, !isLoading);

  let content: JSX.Element | null | undefined;
  const isLandingPage =
    (!messagesTree || messagesTree.length === 0) &&
    (conversationId === Constants.NEW_CONVO || !conversationId);
  const isNavigating = (!messagesTree || messagesTree.length === 0) && conversationId != null;

  if (isLoading && conversationId !== Constants.NEW_CONVO) {
    content = <LoadingSpinner />;
  } else if ((isLoading || isNavigating) && !isLandingPage) {
    content = <LoadingSpinner />;
  } else if (!isLandingPage) {
    content = (
      <MessagesView
        messagesTree={messagesTree}
        hiddenCount={hiddenCountRef.current}
        onShowAllMessages={() => setShowAllMessages(true)}
      />
    );
  } else {
    content = <Landing centerFormOnLanding={centerFormOnLanding} />;
  }

  const { width: inspectorWidth } = useInspector();

  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  useGlobalShortcuts({
    conversationId,
    setValue: methods.setValue,
    onToggleHelp: () => setShortcutHelpOpen((v) => !v),
  });

  return (
    <>
      <ShortcutHelpDialog open={shortcutHelpOpen} onOpenChange={setShortcutHelpOpen} />
      <MCPServerManagerProvider conversationId={conversationId}>
        <ChatFormProvider {...methods}>
          <ChatContext.Provider value={chatHelpers}>
            <AddedChatContext.Provider value={addedChatHelpers}>
              <Presentation>
                <div
                  className="relative flex h-full w-full flex-col transition-[padding] duration-200"
                  style={{ paddingRight: inspectorWidth }}
                >
                  <Header />
                  <>
                    <div
                      className={cn(
                        'flex flex-col',
                        isLandingPage
                          ? 'flex-1 items-center justify-end sm:justify-center'
                          : 'h-full overflow-y-auto',
                      )}
                    >
                      {content}
                      <div
                        className={cn(
                          'w-full',
                          isLandingPage && 'max-w-3xl transition-all duration-200 xl:max-w-4xl',
                        )}
                      >
                        <ChatForm index={index} />
                        {isLandingPage ? <ConversationStarters /> : <Footer />}
                      </div>
                    </div>
                    {isLandingPage && <Footer />}
                  </>
                </div>
              </Presentation>
            </AddedChatContext.Provider>
          </ChatContext.Provider>
        </ChatFormProvider>
      </MCPServerManagerProvider>
    </>
  );
}

export default memo(ChatView);
