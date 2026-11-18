/**
 * The kit (SPEC §5): shared components every area imports from "../components/kit". Foundation-owned; areas
 * arrange kit components but never restyle or fork them (SPEC §4.3 rule 3).
 */
export { Button, IconButton, ToggleButton, SplitButton, shortcutText } from "./button";
export type { ButtonProps, ButtonVariant, IconButtonProps, ToggleButtonProps, SplitButtonProps } from "./button";

export {
  Field,
  TextInput,
  Textarea,
  Select,
  ProjectPicker,
  projectOptions,
  projectPath,
  Checkbox,
  Switch,
  ChoiceCards,
  SearchInput,
  PasswordInput,
  FileDrop,
  FormSection,
  FormActions,
  SaveBar,
  useUnsavedChangesGuard,
  focusFirstInvalid,
} from "./form";
export type { FieldProps, TextareaProps, SelectProps, SelectOption, ProjectPickerProps, CheckboxProps, SwitchProps, ChoiceCardsProps, ChoiceOption, SearchInputProps, FileDropProps, FormActionsProps, SaveBarProps } from "./form";

export { Combobox, ComboboxPanel, filterOptions } from "./combobox";
export type { ComboboxProps, ComboboxPanelProps, ComboOption } from "./combobox";

export { Page, PageHeader, Breadcrumbs, Section, Card, Disclosure, Tabs, SegmentedControl, ChipGroup, FilterBar, AdminTabs, Stepper, SplitView, useSplitView, SPLIT_VIEW_QUERY, projectSwitcher } from "./page";
export type { PageProps, PageHeaderProps, Crumb, CrumbSwitcher, SplitViewProps, SectionProps, CardProps, DisclosureProps, TabItem, TabsProps, SegmentedControlProps, ChipGroupProps, FilterBarProps, StepperProps } from "./page";

export { DataTable, RowList, ListRow, ItemRow, TileGrid, GroupHeader, BulkBar, LoadMore, MetaLine, Facts } from "./data";
export type { Column, DataTableProps, RowListProps, ListRowProps, ItemRowProps, TileGridProps, GroupHeaderProps, BulkBarProps, LoadMoreProps } from "./data";

export {
  Badge,
  StatusBadge,
  CategoryBadge,
  TypeLabel,
  LocationLabel,
  CountBadge,
  Chip,
  LinkChip,
  Avatar,
  AvatarStack,
  PersonChip,
  displayName,
  RelativeTime,
  Kbd,
  KeyHint,
  CodeBlock,
  CopyButton,
  SecretReveal,
  RunWithClaude,
  initials,
} from "./display";
export type { BadgeProps, StatusBadgeProps, TypeLabelProps, LocationLabelProps, CountBadgeProps, ChipProps, LinkChipProps, AvatarProps, AvatarStackProps, PersonChipProps, RelativeTimeProps, CodeBlockProps, CopyButtonProps, SecretRevealProps, RunWithClaudeProps } from "./display";

export {
  ToastProvider,
  useToast,
  Callout,
  ErrorState,
  humanizeError,
  EmptyState,
  Skeleton,
  SkeletonText,
  SkeletonRows,
  SkeletonCard,
  SkeletonTiles,
  Spinner,
  AsyncBlock,
  NewItemsPill,
  useAsyncAction,
} from "./feedback";
export type { ToastApi, ToastOptions, ErrorToastOptions, CalloutProps, ErrorStateProps, EmptyStateProps, AsyncBlockProps, NewItemsPillProps } from "./feedback";

export { KitProvider, Dialog, Sheet, Popover, Menu, MenuButton, OverflowMenu, Tooltip, InfoTip, useConfirm } from "./overlay";
export type { MenuItemSpec, MenuProps, MenuButtonProps, OverflowMenuProps, PopoverProps, TooltipProps, InfoTipProps, DialogProps, SheetProps, ConfirmOptions, ConfirmResult } from "./overlay";

export { DiffView } from "./diff";
export type { DiffViewProps } from "./diff";

export { GateCard, Splash } from "./gate";
export type { GateCardProps } from "./gate";
