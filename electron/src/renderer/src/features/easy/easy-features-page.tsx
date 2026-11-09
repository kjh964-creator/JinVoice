import { useTranslation } from 'react-i18next';
import { EasyFeatureSettings } from './easy-feature-settings';
import { EasyPage } from './easy-layout';

/**
 * The feature switches as an easy screen (large text, phone friendly), opened
 * from the easy home. Settings → General shows the same list.
 */
export function EasyFeaturesPage() {
  const { t } = useTranslation();
  return (
    <EasyPage title={t('easy.features_title')}>
      <div className="mx-auto w-full max-w-6xl lg:[&_[data-slot=easy-feature-settings]>div>ul]:grid lg:[&_[data-slot=easy-feature-settings]>div>ul]:grid-cols-2 lg:[&_[data-slot=easy-feature-settings]>div>ul]:divide-y-0 lg:[&_[data-slot=easy-feature-settings]>div>ul>li]:border-b lg:[&_[data-slot=easy-feature-settings]>div>ul>li]:border-border/50">
        <EasyFeatureSettings variant="page" />
      </div>
    </EasyPage>
  );
}
