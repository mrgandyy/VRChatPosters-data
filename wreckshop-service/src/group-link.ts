const groupId = /^grp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function normalizeGroupLink(value: string): string {
  let id = value.trim();
  if (!groupId.test(id)) {
    try {
      const url = new URL(id);
      if (url.protocol !== 'https:' || url.hostname !== 'vrchat.com' || url.port || url.username || url.password)
        throw new Error();
      id = url.pathname.replace(/^\/home\/group\//, '').replace(/\/$/, '');
    } catch { throw new Error('Provide your VRChat group ID (grp_ followed by its UUID) or its https://vrchat.com/home/group/ URL.'); }
  }
  if (!groupId.test(id)) throw new Error('That is not a VRChat group ID. Open your group on VRChat.com and copy the grp_ ID from its page URL.');
  return `https://vrchat.com/home/group/${id.toLowerCase()}`;
}
export function groupLinkPrompt(group: { id: number; tier: string; vrchatUrl: string | null }): string {
  if (group.tier !== 'premium') return 'Join group is a Premium feature.';
  return group.vrchatUrl ? `Join group: ${group.vrchatUrl}` :
    `Please add your VRChat group ID: /group link group:${group.id} vrchat_group:grp_<your-group-UUID>. Find it in your group's VRChat.com page URL. Join group stays hidden until you add it.`;
}

export function isGroupReference(value: string): boolean {
  return /^(grp_|https?:\/\/)/i.test(value.trim());
}

export function validateGroupName(value:string): string {
  const name=value.trim();
  if(isGroupReference(name) || /vrchat\.com\/home\/group\//i.test(name))
    throw new Error('Use your actual group name in name, not a link or grp_ ID. Put the VRChat link or ID in vrchat_group when registering, or use /group link afterward.');
  if(!name || name.length>80 || /[\r\n\x00-\x1f]/.test(name)) throw new Error('Group name must be 1–80 characters.');
  return name;
}
